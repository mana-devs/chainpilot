import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const persist=await mkdtemp(join(tmpdir(),'chainpilot-cloud-test-'));
const port=18787,base=`http://localhost:${port}`;
let child;
// Exercise an isolated, non-executing runtime regardless of the live deployment setting.
async function start(){
 child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--port',String(port),'--persist-to',persist,'--var','EXECUTION_ENABLED:false'],{stdio:['ignore','pipe','pipe']});
 let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b).slice(-4000);});
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw new Error('Worker exited: '+output);
  try{const r=await fetch(base+'/health');if(r.ok)return await r.json();}catch{}
  await new Promise(r=>setTimeout(r,300));
 }
 throw new Error('Worker startup timeout: '+output);
}
async function stop(){if(!child||child.exitCode!==null)return;const p=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await p;}
async function post(path,body,extra={}){return fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(body)});}
try{
 const first=await start();assert.equal(first.execution,'disabled');assert.equal(first.chainId,97);
 const card=await(await fetch(base+'/.well-known/agent-card.json')).json();assert.equal(card.skills[0].id,'negotiate');
 const mcp=await(await post('/mcp',{id:1,method:'tools/list'})).json();assert.equal(mcp.result.tools[0].name,'analyze_position');
 const quote=await(await post('/a2a',{id:1,method:'message/send',params:{message:{parts:[{kind:'data',data:{skill:'negotiate'}}]}}})).json();assert.equal(quote.result.parts[0].data.response.accepted,false);
 assert.equal((await post('/v1/operator/configure',{expiresAt:Math.floor(Date.now()/1000)+120,agentId:'1',signature:'0x'})).status,400);
 assert.equal((await post('/v1/transactions/prepare',{action:'send-anywhere',from:first.provider})).status,400);
 assert.equal((await post('/mcp',{}, {origin:'https://untrusted.example'})).status,403);
 assert.equal((await post('/mcp',{text:'x'.repeat(17000)})).status,413);
 assert.equal((await fetch(base+'/deliveries/1.json')).status,404);
 await fetch(base+'/cdn-cgi/local/scheduled');
 assert.equal((await(await fetch(base+'/health')).json()).workerOnline,true);
 await stop();const second=await start();assert.equal(second.provider,first.provider,'service wallet must survive restart');
 assert.equal(second.execution,'disabled');
 console.log('Cloudflare runtime smoke passed: discovery, refusal before activation, owner checks, limits, scheduler, persistent service wallet. No onchain transaction sent.');
}finally{await stop();await rm(persist,{recursive:true,force:true});}
