import { getAddress, keccak256, toBytes, toHex, encodeFunctionData } from 'viem';
import { address } from '../config.js';
import { pokterAbi } from './pokter-abi.js';
import { checkedBlock, jsonSafe, readPosition } from '../chain/venus.js';

export const POKTER = Object.freeze({
  chainId: 97,
  commerce: '0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE',
  router: '0xD7d36D66d2F1B608A0F943f722D27e3744f66F25',
  policy: '0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA',
  token: '0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565',
  price: '10000000000000000' // 0.01 test U (18 decimals); no real-money service.
});
const sort = v => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
export const canonicalJson = v => JSON.stringify(sort(v)).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const clean = s => [...s.replaceAll('[','(').replaceAll(']',')')].filter(c=>c>=' '||c==='\t'||c==='\n').join('');
export function borrowerFromBrief(task,fallback) {
  if(typeof task!=='string'||task.length>4000) throw new Error('Supply a health-factor brief of at most 4000 characters');
  const matches=[...task.matchAll(/0x[\da-fA-F]{40}\b/g)].map(m=>address(m[0]));
  const unique=[...new Set(matches)];
  if(unique.length>1||(unique.length===0&&fallback===undefined)) throw new Error('Name exactly one borrower wallet address in the brief');
  if(/mainnet|chain\s*56|ethereum|aave|compound/i.test(task)) throw new Error('This service supports Venus isolated pools on BNB testnet (97) only');
  if(/\b(swap|trade|transfer|send funds|execute|repay|borrow for me)\b/i.test(task)) throw new Error('This hire delivers a read-only risk report; vault protection is a separate opt-in service');
  return unique[0]??fallback;
}
export function quoteContent(q) {
  const t=q.response.terms;
  const terms={deliverables:clean(t.deliverables),quality_standards:clean(t.quality_standards)};
  if(t.success_criteria?.length) terms.success_criteria=t.success_criteria.map(clean);
  return {version:1,negotiated_at:q.negotiated_at,task:clean(q.request.task_description),terms,
    price:t.price,currency:t.currency,quote_expires_at:q.quote_expires_at,chain_id:q.chain_id,verifying_contract:getAddress(q.verifying_contract)};
}
export async function makeQuote(account,input,now=Math.floor(Date.now()/1000)) {
  borrowerFromBrief(input.task_description,null);
  if(input.chain_id!==97) throw new Error('Only BNB testnet escrow (97) is supported');
  const terms=input.terms;
  if(!terms||typeof terms.deliverables!=='string'||typeof terms.quality_standards!=='string'||!terms.deliverables.trim()||!terms.quality_standards.trim()||terms.deliverables.length>2000||terms.quality_standards.length>2000) throw new Error('Specify deliverables and quality_standards');
  if(terms.success_criteria!==undefined && (!Array.isArray(terms.success_criteria)||terms.success_criteria.length>10||terms.success_criteria.some(s=>typeof s!=='string'||s.length>500))) throw new Error('Invalid success criteria');
  const q={request:{task_description:input.task_description},response:{accepted:true,terms:{deliverables:terms.deliverables,quality_standards:terms.quality_standards,...(terms.success_criteria?.length?{success_criteria:terms.success_criteria}:{}),price:POKTER.price,currency:POKTER.token}},negotiated_at:now,quote_expires_at:now+900,chain_id:97,verifying_contract:POKTER.commerce};
  q.negotiation_hash=keccak256(toBytes(canonicalJson(quoteContent(q))));
  q.provider_sig=await account.signMessage({message:{raw:q.negotiation_hash}});
  return q;
}
export async function verifyIdentity(client,config,provider) {
  if(!config.agentId) throw new Error('Register and configure the ERC-8004 identity before accepting hires');
  const block=await checkedBlock(client,config);
  const read=functionName=>client.readContract({address:config.identityRegistry,abi:pokterAbi.IdentityRegistry,functionName,args:[BigInt(config.agentId)],blockNumber:block.number});
  const [owner,wallet,uri]=await Promise.all([read('ownerOf'),read('getAgentWallet'),read('tokenURI')]);
  if(owner.toLowerCase()!==config.campaignOwner.toLowerCase()||wallet.toLowerCase()!==provider.toLowerCase()||uri!==`${config.publicUrl}/registration.json`) throw new Error('Agent identity owner, wallet or URI does not match this service');
}
export async function verifyFundedJob(client,config,provider,jobId,lookupQuote,now=Math.floor(Date.now()/1000),acceptedAt=now) {
  if(!/^[1-9]\d{0,30}$/.test(String(jobId))) throw new Error('Invalid job ID');
  await verifyIdentity(client,config,provider);
  const call=(a,abi,functionName,args=[])=>client.readContract({address:a,abi,functionName,args});
  const job=await call(POKTER.commerce,pokterAbi.AgenticCommerce,'getJob',[BigInt(jobId)]);
  if(job.provider.toLowerCase()!==provider.toLowerCase()||Number(job.status)!==1||job.client.toLowerCase()===provider.toLowerCase()) throw new Error('Job must be funded for this provider by a different wallet');
  if(job.evaluator.toLowerCase()!==POKTER.router.toLowerCase()||job.hook.toLowerCase()!==POKTER.router.toLowerCase()) throw new Error('Unsupported job evaluator or hook');
  const [policy,token]=await Promise.all([call(POKTER.router,pokterAbi.EvaluatorRouter,'jobPolicy',[BigInt(jobId)]),call(POKTER.commerce,pokterAbi.AgenticCommerce,'jobPaymentToken',[BigInt(jobId)])]);
  if(policy.toLowerCase()!==POKTER.policy.toLowerCase()||token.toLowerCase()!==POKTER.token.toLowerCase()) throw new Error('Unsupported escrow policy or token');
  const window=await call(policy,pokterAbi.OptimisticPolicy,'disputeWindow');
  if(BigInt(now)+window+120n>=job.expiredAt) throw new Error('Insufficient time to deliver and settle before the onchain deadline');
  if(job.description.length>16000) throw new Error('Job description too large');
  const envelope=JSON.parse(job.description);
  const q=await lookupQuote(envelope.quote?.negotiationHash);
  if(!q||envelope.protocol!=='pokter-job'||envelope.version!==1||envelope.category!=='health-factor'||String(envelope.identity?.tokenId)!==config.agentId||Number(envelope.identity?.chainId)!==97||envelope.provider?.toLowerCase()!==provider.toLowerCase()) throw new Error('Job does not match this identity and a saved quote');
  if(envelope.task!==q.request.task_description||envelope.quote.providerSignature!==q.provider_sig||String(envelope.quote.priceRaw)!==q.response.terms.price||job.budget!==BigInt(q.response.terms.price)||Number(envelope.quote.expiresAt)!==q.quote_expires_at||Number(envelope.quote.domain?.chainId)!==97||envelope.quote.domain?.verifyingContract?.toLowerCase()!==POKTER.commerce.toLowerCase()) throw new Error('Funded terms do not match the signed quote');
  if(acceptedAt>q.quote_expires_at) throw new Error('Funded notification arrived after quote expiry; request a fresh quote');
  return {job,quote:q,borrower:borrowerFromBrief(envelope.task,address(job.client)),reviewWindow:window};
}
export async function riskReport(client,config,borrower) {
  const p=jsonSafe(await readPosition(client,config,borrower));
  const hf=p.healthFactorWad===null?null:Number(p.healthFactorWad)/1e18;
  return {service:'ChainPilot Position Guard',category:'health-factor',scope:'Venus DeFi isolated pool on BNB testnet only',
    verdict:hf===null?'no-debt':hf<1?'liquidatable':hf<1.2?'high-risk':hf<1.5?'watch':'above-1.5',
    liquidationDistancePercent:hf===null?null:Math.max(0,(1-1/hf)*100),position:p,
    interpretation:hf===null?'No entered-market debt was found in this pool.':hf<1?'Liquidation threshold is breached.':`Health factor is ${hf.toFixed(4)}; 1.0 is the liquidation threshold.`,
    limitations:['Other pools, chains and wallets are outside this report.','Stored interest; prices and interest may change after this block.','Liquidation distance assumes unchanged debt and a proportional change in weighted collateral.','No funds were moved by this assessment.'],
    sources:[config.rpcUrl,'https://docs-v4.venus.io/'],observedBlock:p.blockNumber};
}
export function deliveryBytes(jobId,content) {
  return canonicalJson({version:1,job_id:String(jobId),chain_id:97,response:{content:canonicalJson(content)}});
}
export async function sendBounded(client,wallet,request) {
  const {request:simulation}=await client.simulateContract({...request,account:wallet.account});
  const gas=(await client.estimateContractGas(simulation))*120n/100n;
  const gasPrice=await client.getGasPrice();
  if(gas*gasPrice>2000000000000000n) throw new Error('Transaction exceeds 0.002 test BNB gas cap');
  // Persist the signed transaction before broadcast in the caller for crash recovery.
  const prepared=await wallet.prepareTransactionRequest({to:request.address,data:encodeFunctionData(request),value:0n,gas,gasPrice,type:'legacy'});
  const serialized=await wallet.signTransaction(prepared);
  return {serialized,hash:keccak256(serialized)};
}
export const submitRequest=(jobId,bytes,url)=>({address:POKTER.commerce,abi:pokterAbi.AgenticCommerce,functionName:'submit',args:[BigInt(jobId),keccak256(toBytes(bytes)),toHex(JSON.stringify({deliverable_url:url}))]});
