import { DurableObject } from 'cloudflare:workers';
import { createWalletClient, http, encodeFunctionData, verifyMessage, keccak256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { configFromEnv, address } from '../config.js';
import { createClient, jsonSafe } from '../chain/venus.js';
import { agentCard, registrationFile } from '../metadata.js';
import { inspectVault, enroll, enrollmentMessage, tick } from '../agent.js';
import { prepareTransaction } from '../transactions.js';
import { campaignStatus, recordRepayment } from '../campaign.js';
import { DurableStore } from './store.js';
import { POKTER, makeQuote, verifyIdentity, verifyFundedJob, riskReport, deliveryBytes, sendBounded, submitRequest, borrowerFromBrief } from '../marketplace/pokter.js';
import { pokterAbi } from '../marketplace/pokter-abi.js';
import contracts from '../../public/contracts.json';

const reply=(body,status=200)=>new Response(JSON.stringify(jsonSafe(body)),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
const errorMessage=e=>e?.shortMessage?'Onchain request failed; verify configuration and RPC availability.':String(e?.message||'Invalid request').slice(0,200);
const tools=[{name:'analyze_position',description:'Assess one Venus DeFi isolated-pool borrower on BNB testnet (97)',inputSchema:{type:'object',properties:{borrower:{type:'string'}},required:['borrower']}}];
export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&['/','/index.html','/app.js','/style.css','/logo.svg'].includes(path))return env.ASSETS.fetch(request);
    return env.AGENT.get(env.AGENT.idFromName('chainpilot-v1')).fetch(request);
  },
  async scheduled(event,env,ctx){ctx.waitUntil(env.AGENT.get(env.AGENT.idFromName('chainpilot-v1')).wake());}
};
export class ChainPilotAgent extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.queue=Promise.resolve();this.store=new DurableStore(ctx.storage);
    this.ready=ctx.blockConcurrencyWhile(async()=>{
      let key=await ctx.storage.get('service-key');
      if(!key){key=generatePrivateKey();await ctx.storage.put('service-key',key);}
      this.account=privateKeyToAccount(key);
    });
  }
  serial(fn){const p=this.queue.then(fn);this.queue=p.catch(()=>{});return p;}
  async setup(origin){
    await this.ready;
    const settings=await this.ctx.storage.get('settings')||{};
    const publicUrl=this.env.PUBLIC_URL||settings.publicUrl||origin;
    if(!settings.publicUrl&&publicUrl)await this.ctx.storage.put('settings',{...settings,publicUrl});
    if(!publicUrl)throw new Error('PUBLIC_URL is not configured');
    // Start promptly after deploy; cron propagation can otherwise delay the first heartbeat.
    if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+1000);
    this.config={...configFromEnv({...this.env,...settings,PUBLIC_URL:publicUrl,KEEPER_ADDRESS:this.account.address}),marketplace:'pokter'};
    this.client=createClient(this.config);
    this.wallet=createWalletClient({account:this.account,chain:bscTestnet,transport:http(this.config.rpcUrl,{timeout:12000,retryCount:1})});
  }
  async wake(){return this.serial(async()=>{await this.setup();await this.run();});}
  async alarm(){await this.wake();}
  async run(){
    // Schedule first so transient RPC errors do not silently stop the worker.
    await this.ctx.storage.setAlarm(Date.now()+60000);
    await this.store.update(s=>{s.worker={at:Date.now(),executionEnabled:this.config.executionEnabled};});
    if(this.config.factory){const results=await tick({client:this.client,wallet:this.wallet,config:this.config,store:this.store});for(const r of results)if(r.status==='confirmed')await recordRepayment(this.client,this.config,this.store,r.hash).catch(()=>{});}
    const pending=await this.ctx.storage.list({prefix:'job:',limit:25});
    const ordered=[...pending].sort((a,b)=>Number(!!b[1].pending)-Number(!!a[1].pending));
    for(const [key,entry] of ordered){
      try{if(await this.processJob(key,entry))break;}catch(e){
        // Preserve a pending transaction saved immediately before a broadcast failure.
        const latest=await this.ctx.storage.get(key)||entry;
        await this.ctx.storage.put(key,{...latest,lastError:errorMessage(e),lastAttempt:Date.now()});
        if(latest.pending)break;
      }
    }
    const expired=await this.ctx.storage.list({prefix:'quote:',limit:500});
    const old=[];for(const [key,q] of expired)if(q.quote_expires_at<Date.now()/1000-86400)old.push(key);
    if(old.length)await this.ctx.storage.delete(old);
  }
  async processJob(key,entry){
    const call=(a,abi,functionName,args)=>this.client.readContract({address:a,abi,functionName,args});
    const job=await call(POKTER.commerce,pokterAbi.AgenticCommerce,'getJob',[BigInt(entry.id)]);
    if(!entry.pending&&[3,4,5].includes(Number(job.status))){await this.ctx.storage.put(`history:${entry.id}`,{id:entry.id,client:entry.client,borrower:entry.borrower,status:Number(job.status),completedAt:Date.now(),lastTx:entry.lastTx});await this.ctx.storage.delete(key);return;}
    if(entry.pending){
      const p=entry.pending;
      let receipt;
      try{receipt=await this.client.getTransactionReceipt({hash:p.hash});}catch{
        // Re-broadcast identical signed bytes; never create a second nonce on uncertainty.
        if(this.config.executionEnabled)await this.client.sendRawTransaction({serializedTransaction:p.serialized}).catch(()=>{});
        return true;
      }
      if(await this.client.getBlockNumber()<receipt.blockNumber+1n)return true;
      await this.ctx.storage.put(key,{...entry,pending:null,lastTx:p.hash,lastTxStatus:receipt.status});return true;
    }
    if(!this.config.executionEnabled)return;
    await verifyIdentity(this.client,this.config,this.account.address);
    if(Number(job.status)===1){
      const verified=await verifyFundedJob(this.client,this.config,this.account.address,entry.id,async h=>entry.quote?.negotiation_hash===h?entry.quote:this.ctx.storage.get(`quote:${h}`),Math.floor(Date.now()/1000),Math.floor(entry.acceptedAt/1000));
      let bytes=await this.ctx.storage.get(`delivery:${entry.id}`);
      if(!bytes){bytes=deliveryBytes(entry.id,await riskReport(this.client,this.config,verified.borrower));await this.ctx.storage.put(`delivery:${entry.id}`,bytes);}
      const pending=await sendBounded(this.client,this.wallet,submitRequest(entry.id,bytes,`${this.config.publicUrl}/deliveries/${entry.id}.json`));
      await this.ctx.storage.put(key,{...entry,pending});
      await this.client.sendRawTransaction({serializedTransaction:pending.serialized});return true;
    }else if(Number(job.status)===2){
      if(job.provider.toLowerCase()!==this.account.address.toLowerCase()||job.evaluator.toLowerCase()!==POKTER.router.toLowerCase())throw new Error('Job provider or evaluator changed');
      const bytes=await this.ctx.storage.get(`delivery:${entry.id}`);
      if(!bytes||keccak256(toBytes(bytes))!==job.deliverable)throw new Error('Onchain delivery hash differs from stored bytes');
      const policy=await call(POKTER.router,pokterAbi.EvaluatorRouter,'jobPolicy',[BigInt(entry.id)]);
      if(policy.toLowerCase()!==POKTER.policy.toLowerCase())throw new Error('Unexpected policy');
      const window=await call(policy,pokterAbi.OptimisticPolicy,'disputeWindow',[]);
      const now=BigInt(Math.floor(Date.now()/1000));
      if(now<=job.submittedAt+window||now>=job.expiredAt)return;
      const pending=await sendBounded(this.client,this.wallet,{address:POKTER.router,abi:pokterAbi.EvaluatorRouter,functionName:'settle',args:[BigInt(entry.id),'0x']});
      await this.ctx.storage.put(key,{...entry,pending});await this.client.sendRawTransaction({serializedTransaction:pending.serialized});return true;
    }
  }
  async fetch(request){return this.serial(async()=>{
    try{
      await this.setup(new URL(request.url).origin);
      const path=new URL(request.url).pathname,c=this.config;
      // Each public request is bounded. No client-supplied URL is fetched or executed.
      const rateKey=`rate:${request.headers.get('cf-connecting-ip')||'local'}`;
      const minute=Math.floor(Date.now()/60000);
      // Keep rate limits in memory rather than writing on every probe.
      this.rates??=new Map();const r=this.rates.get(rateKey);const n=r?.minute===minute?r.count+1:1;
      this.rates.set(rateKey,{minute,count:n});if(this.rates.size>2000)this.rates.clear();if(n>60)return reply({error:'Rate limit exceeded'},429);
      if(request.method==='GET'){
        if(path==='/health'){const s=await this.store.read();return reply({name:'ChainPilot',status:'running',hosting:'Cloudflare Free / SQLite Durable Object',chainId:97,workerOnline:!!s.worker&&Date.now()-s.worker.at<180000,execution:c.executionEnabled?'enabled':'disabled',factoryConfigured:!!c.factory,identityConfigured:!!c.agentId,provider:this.account.address});}
        if(path==='/v1/config')return reply({...c,rpcUrl:undefined,dataDir:undefined,executionEnabled:undefined,marketplace:'pokter',provider:this.account.address});
        if(path==='/registration.json')return reply({...registrationFile(c),agentWallet:this.account.address});
        if(path==='/.well-known/agent-card.json'||path==='/.well-known/agent.json')return reply(agentCard({...c,marketplace:'pokter'}));
        if(path==='/v1/campaign')return reply(await this.campaign());
        if(path==='/v1/jobs'){const rows=await this.ctx.storage.list({prefix:'history:',limit:100});return reply([...rows.values()].map(({pending,quote,...row})=>row));}
        const match=path.match(/^\/deliveries\/([1-9]\d{0,30})\.json$/);
        if(match){const bytes=await this.ctx.storage.get(`delivery:${match[1]}`);return bytes?new Response(bytes,{headers:{'content-type':'application/json','cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'}}):reply({error:'Not found'},404);}
        return reply({error:'Not found'},404);
      }
      if(request.method!=='POST')return reply({error:'Use GET or POST'},405);
      if(request.headers.get('origin')&&request.headers.get('origin')!==c.publicUrl)return reply({error:'Origin not allowed'},403);
      if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'Use application/json'},415);
      if(Number(request.headers.get('content-length'))>16384)return reply({error:'Request too large'},413);
      const reader=request.body?.getReader();let total=0;const chunks=[];
      if(reader)for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>16384){await reader.cancel();return reply({error:'Request too large'},413);}chunks.push(value);}
      const raw=new Uint8Array(total);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
      const body=JSON.parse(new TextDecoder().decode(raw));if(!body||typeof body!=='object'||Array.isArray(body))return reply({error:'JSON object required'},400);
      if(path==='/v1/position')return reply((await riskReport(this.client,c,address(body.borrower))).position);
      if(path==='/v1/vault')return reply(await inspectVault(this.client,c,address(body.vault),body.targetBps||15000));
      if(path==='/v1/transactions/prepare'){
        if(body.action==='set-agent-wallet')return reply(await this.walletBinding(body.from));
        return reply(await prepareTransaction(c,body,this.client,contracts));
      }
      if(path==='/v1/operator/configure')return reply(await this.configure(body));
      if(path==='/v1/enrollment-message'){
        if(!/^\d{1,30}$/.test(String(body.subscriptionId))||!Number.isSafeInteger(body.targetBps)||body.targetBps<=10000||body.targetBps>50000)throw new Error('Subscription ID and targetBps required');
        const input={...body,expiresAt:Math.floor(Date.now()/1000)+300};return reply({...input,message:`${enrollmentMessage(c,input)}\nTarget health factor (bps): ${input.targetBps}`});
      }
      if(path==='/v1/enroll')return reply(await enroll(this.client,c,this.store,body));
      if(path==='/v1/evidence/repayment')return reply(await recordRepayment(this.client,c,this.store,body.hash));
      if(path==='/mcp'){
        let result;
        if(body.method==='notifications/initialized')return new Response(null,{status:202});
        if(body.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ChainPilot',version:'0.3.0'}};
        else if(body.method==='tools/list')result={tools};else if(body.method==='ping')result={};
        else if(body.method==='tools/call'&&body.params?.name==='analyze_position')result={content:[{type:'text',text:JSON.stringify(await riskReport(this.client,c,address(body.params.arguments.borrower)))}]};
        else return reply({jsonrpc:'2.0',id:body.id??null,error:{code:-32601,message:'Method not found'}});
        return reply({jsonrpc:'2.0',id:body.id??null,result});
      }
      if(path==='/a2a'){
        if(body.method!=='message/send')return reply({jsonrpc:'2.0',id:body.id??null,error:{code:-32601,message:'Use message/send'}});
        const parts=body.params?.message?.parts||[];const data=parts.find(p=>p.kind==='data')?.data||{};
        let result;
        console.log('a2a message',JSON.stringify({skill:data.skill,kinds:parts.map(p=>p.kind),keys:Object.keys(data),chain_id:data.chain_id,task:String(data.task_description||parts.map(p=>p.text||'').join(' ')).slice(0,200)}));
        if(data.skill==='negotiate'){
          try{await verifyIdentity(this.client,c,this.account.address);if(!c.executionEnabled)throw new Error('Paid delivery is not enabled yet; use the free preview');
            const q=await makeQuote(this.account,data);await this.ctx.storage.put(`quote:${q.negotiation_hash}`,q);result=q;
          }catch(e){console.log('negotiate declined',errorMessage(e),JSON.stringify({task:String(data.task_description).slice(0,300),chain_id:data.chain_id,escrow_chains:data.escrow_chains}));result={response:{accepted:false,reason:errorMessage(e)}};}
        }else if(data.skill==='notify_funded'){
          const id=String(data.job_id);const existing=await this.ctx.storage.get(`job:${id}`)||await this.ctx.storage.get(`history:${id}`);
          if(existing)result={status:'accepted',job_id:id};
          else{const v=await verifyFundedJob(this.client,c,this.account.address,id,h=>this.ctx.storage.get(`quote:${h}`));await this.ctx.storage.put(`job:${id}`,{id,quote:v.quote,client:v.job.client,borrower:v.borrower,expiredAt:String(v.job.expiredAt),acceptedAt:Date.now()});await this.ctx.storage.setAlarm(Date.now()+1000);result={status:'accepted',job_id:id};}
        }else{const text=data.task_description||parts.filter(p=>p.kind==='text').map(p=>p.text).join(' ');const borrower=data.borrower?address(data.borrower):borrowerFromBrief(text);result=await riskReport(this.client,c,borrower);}
        return reply({jsonrpc:'2.0',id:body.id??null,result:{kind:'message',messageId:crypto.randomUUID(),role:'agent',parts:[{kind:'data',data:result}]}});
      }
      return reply({error:'Not found'},404);
    }catch(e){return reply({error:errorMessage(e)},400);}
  });}
  async campaign(){
    const c=this.config;
    const result=await campaignStatus(this.client,{...c,agentId:null},this.store);
    try{await verifyIdentity(this.client,c,this.account.address);result.checks.identity={status:'verified',agentId:c.agentId,owner:c.campaignOwner};}catch{result.checks.identity={status:'pending',agentId:c.agentId};}
    result.checks.marketplace={status:'needs-Pokter-external-check',url:c.agentId?`https://pokter.xyz/agents/97/${c.agentId}`:'https://pokter.xyz/build'};
    const rows=await this.ctx.storage.list({prefix:'history:',limit:100});
    const completed=new Set([...rows.values()].filter(r=>r.status===3&&r.client?.toLowerCase()!==c.campaignOwner.toLowerCase()).map(r=>r.client.toLowerCase()));
    result.checks.independentHires={status:'requires-organizer-verification',completedServiceWallets:completed.size,required:3,note:'Completed escrow jobs observed onchain; distinct buyers do not prove ownership or funding independence.'};
    return result;
  }
  async walletBinding(from){
    const c=this.config;if(address(from).toLowerCase()!==c.campaignOwner.toLowerCase()||!c.agentId)throw new Error('Configured identity and campaign owner required');
    const owner=await this.client.readContract({address:c.identityRegistry,abi:pokterAbi.IdentityRegistry,functionName:'ownerOf',args:[BigInt(c.agentId)]});
    if(owner.toLowerCase()!==c.campaignOwner.toLowerCase())throw new Error('Identity is not owned by campaign wallet');
    const domain=await this.client.readContract({address:c.identityRegistry,abi:pokterAbi.IdentityRegistry,functionName:'eip712Domain'});
    const deadline=BigInt(Math.floor(Date.now()/1000)+240);
    const signature=await this.account.signTypedData({domain:{name:domain[1],version:domain[2],chainId:97,verifyingContract:c.identityRegistry},types:{AgentWalletSet:[{name:'agentId',type:'uint256'},{name:'newWallet',type:'address'},{name:'owner',type:'address'},{name:'deadline',type:'uint256'}]},primaryType:'AgentWalletSet',message:{agentId:BigInt(c.agentId),newWallet:this.account.address,owner,deadline}});
    return {from:owner,chainId:'0x61',to:c.identityRegistry,value:'0x0',data:encodeFunctionData({abi:pokterAbi.IdentityRegistry,functionName:'setAgentWallet',args:[BigInt(c.agentId),this.account.address,deadline,signature]})};
  }
  async configure(body){
    const c=this.config,expiresAt=body.expiresAt;
    if(!Number.isSafeInteger(expiresAt)||expiresAt<Date.now()/1000||expiresAt>Date.now()/1000+300)throw new Error('Configuration signature expired');
    const settings={PUBLIC_URL:c.publicUrl};
    if(body.agentId){if(!/^\d{1,30}$/.test(String(body.agentId)))throw new Error('Invalid agent ID');settings.AGENT_ID=String(body.agentId);}
    if(body.factory)settings.FACTORY_ADDRESS=address(body.factory);
    // Execution is deliberately not toggled by this public endpoint.
    const message=`ChainPilot configuration\nService: ${c.publicUrl}\nChain: 97\nAgent ID: ${settings.AGENT_ID||''}\nFactory: ${settings.FACTORY_ADDRESS?.toLowerCase()||''}\nExpiry: ${expiresAt}`;
    if(!await verifyMessage({address:c.campaignOwner,message,signature:body.signature}))throw new Error('Campaign owner signature required');
    if(settings.AGENT_ID){const owner=await this.client.readContract({address:c.identityRegistry,abi:pokterAbi.IdentityRegistry,functionName:'ownerOf',args:[BigInt(settings.AGENT_ID)]});if(owner.toLowerCase()!==c.campaignOwner.toLowerCase())throw new Error('Wrong identity owner');}
    if(settings.FACTORY_ADDRESS){const check=await inspectFactory(this.client,c,settings.FACTORY_ADDRESS);if(!check)throw new Error('Factory profile mismatch');}
    const previous=await this.ctx.storage.get('settings')||{};await this.ctx.storage.put('settings',{...previous,...settings,publicUrl:c.publicUrl});await this.ctx.storage.setAlarm(Date.now()+1000);return {configured:true,...settings};
  }
}
async function inspectFactory(client,c,factory){const {factoryAbi}=await import('../chain/abi.js');const [controller,market]=await Promise.all(['controller','market'].map(functionName=>client.readContract({address:factory,abi:factoryAbi,functionName})));return controller.toLowerCase()===c.controller.toLowerCase()&&market.toLowerCase()===c.market.toLowerCase();}
