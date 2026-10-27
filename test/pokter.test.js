import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage, keccak256, toBytes } from 'viem';
import { makeQuote, canonicalJson, quoteContent, POKTER, borrowerFromBrief, verifyFundedJob, deliveryBytes, sendBounded } from '../src/marketplace/pokter.js';
import { configFromEnv } from '../src/config.js';
import { agentCard } from '../src/metadata.js';
const account=privateKeyToAccount('0x'+'11'.repeat(32));
const buyer='0x2222222222222222222222222222222222222222';
const config={...configFromEnv({PUBLIC_URL:'https://chainpilot.example',AGENT_ID:'123'}),marketplace:'pokter'};
const task=`Assess liquidation risk for ${buyer} on Venus BNB testnet (97).`;
const input={task_description:task,chain_id:97,terms:{deliverables:'A JSON health-factor report [with block] é',quality_standards:'Read-only assessment.',success_criteria:['Name the source block.']}};
test('Pokter canonical quote signs exact terms, including unicode and success criteria',async()=>{
 const q=await makeQuote(account,input);
 assert.equal(await verifyMessage({address:account.address,message:{raw:q.negotiation_hash},signature:q.provider_sig}),true);
 assert.equal(q.negotiation_hash,keccak256(toBytes(canonicalJson(quoteContent(q)))));
 assert.match(canonicalJson(quoteContent(q)),/\\u00e9/);assert.ok(!quoteContent(q).terms.deliverables.includes('['));
 assert.deepEqual(q.response.terms.success_criteria,input.terms.success_criteria);
 const changed=structuredClone(q);changed.response.terms.price='2';assert.notEqual(keccak256(toBytes(canonicalJson(quoteContent(changed)))),q.negotiation_hash);
});
test('unsupported chains, ambiguous borrowers and fund-moving briefs are refused',async()=>{
 await assert.rejects(makeQuote(account,{...input,chain_id:56}),/testnet/);
 assert.throws(()=>borrowerFromBrief('Analyze mainnet '+buyer),/testnet/);
 assert.throws(()=>borrowerFromBrief('Repay '+buyer),/read-only/);
 assert.throws(()=>borrowerFromBrief(task+' '+account.address),/exactly one/);
 await assert.rejects(makeQuote(account,{...input,terms:{}}),/deliverables/);
});
async function fixture(){
 const q=await makeQuote(account,input);const now=Math.floor(Date.now()/1000);
 const envelope={protocol:'pokter-job',version:1,identity:{chainId:97,tokenId:'123'},category:'health-factor',provider:account.address,task,quote:{negotiationHash:q.negotiation_hash,providerSignature:q.provider_sig,priceRaw:POKTER.price,expiresAt:q.quote_expires_at,domain:{chainId:97,verifyingContract:POKTER.commerce}}};
 const job={id:1n,client:buyer,provider:account.address,evaluator:POKTER.router,hook:POKTER.router,description:JSON.stringify(envelope),budget:BigInt(POKTER.price),expiredAt:BigInt(now+86400),status:1,submittedAt:0n};
 const state={job,policy:POKTER.policy,token:POKTER.token,owner:config.campaignOwner,provider:account.address};
 const client={getChainId:async()=>97,getBlock:async()=>({number:1n,timestamp:BigInt(now)}),readContract:async({functionName})=>({ownerOf:state.owner,getAgentWallet:state.provider,tokenURI:config.publicUrl+'/registration.json',getJob:state.job,jobPolicy:state.policy,jobPaymentToken:state.token,disputeWindow:900n}[functionName])};
 return {q,state,client,envelope,lookup:async hash=>hash===q.negotiation_hash?q:null};
}
test('funded-job verification checks identity, signed terms, token, policy and deadline',async()=>{
 const f=await fixture();const verify=()=>verifyFundedJob(f.client,config,account.address,'1',f.lookup);
 assert.equal((await verify()).borrower,buyer);
 for(const [key,bad] of [['provider',buyer],['evaluator',buyer],['hook',buyer],['status',0],['budget',1n],['expiredAt',1n],['client',account.address]]){
  const old=f.state.job[key];f.state.job[key]=bad;await assert.rejects(verify,undefined,key);f.state.job[key]=old;
 }
 for(const key of ['policy','token','owner','provider']){const old=f.state[key];f.state[key]=buyer;await assert.rejects(verify);f.state[key]=old;}
 const changed=structuredClone(f.envelope);changed.task='Different brief '+buyer;f.state.job.description=JSON.stringify(changed);await assert.rejects(verify,/terms/);
});
test('unrecognized quote and changed identity cannot enqueue a paid job',async()=>{
 const f=await fixture();await assert.rejects(verifyFundedJob(f.client,config,account.address,'1',async()=>null),/saved quote/);
 f.envelope.identity.tokenId='124';f.state.job.description=JSON.stringify(f.envelope);
 await assert.rejects(verifyFundedJob(f.client,config,account.address,'1',f.lookup),/identity/);
});
test('delivery bytes are stable, canonical and hashable across restarts',()=>{
 const bytes=deliveryBytes('4',{b:2,a:'é'});assert.equal(bytes,deliveryBytes('4',{a:'é',b:2}));
 assert.deepEqual(JSON.parse(JSON.parse(bytes).response.content),{a:'é',b:2});
});
test('bounded send simulates first and does not broadcast; caller can persist signed bytes',async()=>{
 let signed=false;
 const client={simulateContract:async()=>({request:{to:POKTER.commerce,data:'0x'}}),estimateContractGas:async()=>100000n,getGasPrice:async()=>1000000000n};
 const wallet={account,prepareTransactionRequest:async r=>{assert.equal(r.to,POKTER.commerce);assert.match(r.data,/^0x[0-9a-f]{8}$/);return r;},signTransaction:async()=>{signed=true;return '0x1234';}};
 const tx=await sendBounded(client,wallet,{address:POKTER.commerce,abi:[{type:'function',name:'submit',inputs:[],outputs:[],stateMutability:'nonpayable'}],functionName:'submit'});assert.equal(signed,true);assert.equal(tx.hash,keccak256('0x1234'));
 signed=false;client.getGasPrice=async()=>100000000000000n;await assert.rejects(sendBounded(client,wallet,{}),/gas cap/);assert.equal(signed,false);
});
test('Pokter card declares anonymous JSON-RPC pricing, funded notifications and preview',()=>{
 const card=agentCard(config);assert.equal(card.category,'health-factor');assert.equal(card.preferredTransport,'JSONRPC');
 assert.deepEqual(card.skills.map(s=>s.id),['negotiate','notify_funded','preview']);assert.ok(card.skills[0].examples.length);
});

test('canonical hashing matches Pokter published independent reference vector',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./fixtures/pokter-worked-example.json',import.meta.url),'utf8'));
 assert.equal(canonicalJson(fixture.content),fixture.canonical);
 assert.equal(keccak256(toBytes(canonicalJson(fixture.content))),fixture.negotiationHash);
});
test('A brief that names no borrower is quoted and falls back to the hiring wallet',async()=>{
 const q=await makeQuote(account,{...input,task_description:'Quote your standard deliverable so a buyer can see the price before hiring.'});
 assert.equal(q.response.accepted,true);
 assert.equal(borrowerFromBrief(q.request.task_description,buyer),buyer);
 assert.throws(()=>borrowerFromBrief('Quote it.'),/exactly one borrower/);
 await assert.rejects(makeQuote(account,{...input,task_description:`Assess ${buyer} and 0x3333333333333333333333333333333333333333`}),/exactly one borrower/);
});
