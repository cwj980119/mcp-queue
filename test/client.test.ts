import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClientApp } from '../src/client.js';
import { createApp } from '../src/server.js';
import { tokenHash, type AuthEntry } from '../src/auth.js';
import { createSchema } from '../src/types.js';
import { readJsonc } from '../src/local-config.js';
import { readConnection } from '../src/connection.js';
import { waitFor } from './workflow.js';

test('server bootstrap creates one user file and preserves credentials on restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'queue-bootstrap-'));
  const env={...process.env,AUTH_MODE:'legacy',QUEUE_SETUP_DIR:dir,QUEUE_SERVER_URL:'https://queue.example.test'};
  try{
    execFileSync(process.execPath,['scripts/bootstrap.mjs'],{env,stdio:'pipe'});
    const before=readFileSync(join(dir,'auth.json'),'utf8');const bundle=readConnection(readFileSync(join(dir,'connections','alice.queue.json'),'utf8'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'server-auth','auth.json'),'utf8')),JSON.parse(before));
    assert.equal(bundle.serverUrl,'https://queue.example.test');assert.equal(bundle.userId,'alice');
    execFileSync(process.execPath,['scripts/bootstrap.mjs'],{env,stdio:'pipe'});
    assert.equal(readFileSync(join(dir,'auth.json'),'utf8'),before);
    assert.equal(readConnection(readFileSync(join(dir,'connections','alice.queue.json'),'utf8')).agentToken,bundle.agentToken);
    execFileSync(process.execPath,['scripts/bootstrap.mjs'],{env:{...env,QUEUE_SERVER_URL:'',QUEUE_BIND_ADDRESS:'0.0.0.0',QUEUE_HOST_ADDRESS:'192.0.2.15',QUEUE_PUBLIC_PORT:'4510'},stdio:'pipe'});
    const updated=readConnection(readFileSync(join(dir,'connections','alice.queue.json'),'utf8'));
    assert.equal(updated.serverUrl,'http://192.0.2.15:4510');assert.equal(updated.humanToken,bundle.humanToken);assert.equal(updated.workerToken,bundle.workerToken);
    assert.equal(JSON.parse(readFileSync(join(dir,'alice','manager.json'),'utf8')).serverUrl,updated.serverUrl);
    assert.equal(readFileSync(join(dir,'server-address.txt'),'utf8').trim(),updated.serverUrl);
    assert.throws(()=>readConnection(JSON.stringify({...bundle,serverUrl:'file:///bad'})));
    assert.throws(()=>readConnection(JSON.stringify({...bundle,humanToken:'bad\nheader'.repeat(4)})));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

for(const runtime of ['opencode','claude-code'] as const)test(`guided setup (${runtime}) preserves settings, discovers tools, connects, stops and resumes`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'queue-client-'));const home=join(dir,'home'),project=join(dir,'project'),stateDir=join(dir,'state');
  mkdirSync(home,{recursive:true});mkdirSync(project,{recursive:true});
  const tokens=Object.fromEntries(['alice','bob'].map(id=>[id,Object.fromEntries(['human','agent','worker'].map(role=>[role,randomBytes(32).toString('hex')]))])) as Record<string,Record<string,string>>;
  const auth=Object.entries(tokens).flatMap(([id,roles])=>Object.entries(roles).map(([role,token])=>({id,name:id,role,tokenHash:tokenHash(token)}))) as AuthEntry[];
  const central=createApp({database:join(dir,'queue.sqlite'),auth});
  await new Promise<void>(done=>central.http.listen(0,'127.0.0.1',done));
  const serverUrl=`http://127.0.0.1:${(central.http.address() as {port:number}).port}`;
  const source={command:process.execPath,args:[resolve('test/fixtures/docs-mcp.mjs')]};
  const globalPath=runtime==='opencode'?join(home,'.config','opencode','opencode.json'):join(home,'.claude.json');
  mkdirSync(join(home,'.config','opencode'),{recursive:true});
  writeFileSync(globalPath,'// preserve this comment\n'+JSON.stringify(runtime==='opencode'?{provider:{corp:{apiKey:'FIXTURE_PRIVATE_PROVIDER'}},mcp:{old:{type:'local',command:[process.execPath,'unused']}}}:{mcpServers:{old:{command:'unused'}},otherSetting:42}));
  if(runtime==='opencode')writeFileSync(join(project,'opencode.json'),JSON.stringify({mcp:{corpdocs:{type:'local',command:[source.command,...source.args]}},agent:{'queue-reader':{permission:{'*':'allow'}}}}));
  else writeFileSync(join(project,'.mcp.json'),JSON.stringify({mcpServers:{corpdocs:source}}));
  const commands={opencode:[process.execPath,resolve('test/fixtures/opencode-serve.mjs'),'--fixture-home',home],
    'claude-code':[process.execPath,resolve('test/fixtures/claude-cli.mjs')]};
  const local=createClientApp({stateDir,home,commands});await new Promise<void>(done=>local.http.listen(0,'127.0.0.1',done));
  const base=`http://127.0.0.1:${(local.http.address() as {port:number}).port}`;
  const call=async(path:string,body?:unknown,status=200,headers:Record<string,string>={})=>{
    const response=await fetch(`${base}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Client-Key':local.key,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.status,status,`${path} unexpected response`);return response.json() as Promise<any>;
  };
  const bundle=(id:string)=>({version:1,serverUrl,userId:id,name:id,humanToken:tokens[id].human,agentToken:tokens[id].agent,workerToken:tokens[id].worker});
  try{
    assert.equal((await fetch(`${base}/api/state`)).status,403);
    assert.equal((await fetch(`${base}/api/state`,{headers:{'X-Client-Key':local.key,Origin:'https://untrusted.invalid'}})).status,403);
    await call('import',{text:JSON.stringify(bundle('bob'))});
    const inspected=await call('inspect',{runtime,directory:project});assert(inspected.project.servers.includes('corpdocs'));
    assert(!JSON.stringify(inspected).includes('FIXTURE_PRIVATE_PROVIDER'));
    const listed=await call('tools',{server:'corpdocs'});assert(listed.tools.some((tool:any)=>tool.name==='read'));
    await call('connect',{server:'corpdocs',tools:['not_listed']},400);
    const connected=await call('connect',{server:'corpdocs',tools:['read']});assert(connected.running);assert.equal(connected.backups.length,1);
    const changed=readJsonc(globalPath);assert(readFileSync(globalPath,'utf8').includes('preserve this comment'));
    if(runtime==='opencode'){assert.equal(changed.provider.corp.apiKey,'FIXTURE_PRIVATE_PROVIDER');assert(changed.mcp.old);assert.equal(changed.agent['queue-reader'].permission['*'],'deny');assert.equal(changed.agent['queue-reader'].permission.corpdocs_read,'allow');}
    else{assert.equal(changed.otherSetting,42);assert(changed.mcpServers.old);}
    const task=central.store.create({id:'alice',name:'alice',role:'human'},createSchema.parse({recipient:'bob',title:'guided setup test',body:'read DOC-42',idempotencyKey:randomUUID()}));
    central.store.act({id:'bob',name:'bob',role:'human'},task.id,'approve');
    await waitFor(async()=>central.store.get({id:'bob',name:'bob',role:'human'},task.id).state==='draft');
    const login=await call('login',{});assert.equal(new URL(login.url).search,'');assert(new URL(login.url).hash.startsWith('#login='));
    assert(!(await call('stop',{})).running);assert((await call('start',{})).running);await call('stop',{});
    await call('import',{text:JSON.stringify(bundle('alice'))});assert.equal((await call('state')).configured,false);
    assert(!JSON.stringify(await call('state')).includes(tokens.bob.human));
  }finally{await local.close();await central.close();rmSync(dir,{recursive:true,force:true});}
});
