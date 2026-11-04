import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { tokenHash, type AuthEntry } from '../src/auth.js';
import { createSchema, type Actor } from '../src/types.js';
import { Manager } from '../src/manager.js';
import { managerSchema } from '../src/opencode.js';
import { waitFor } from './workflow.js';

test('network failure before/after draft commit retries delivery without rerunning OpenCode', async () => {
  const dir=mkdtempSync(join(tmpdir(),'queue-recovery-'));
  const tokens={alice:randomUUID()+randomUUID(),bob:randomUUID()+randomUUID()};
  const auth:AuthEntry[]=[{id:'alice',name:'A',role:'human',tokenHash:tokenHash(tokens.alice)}, {id:'bob',name:'B',role:'worker',tokenHash:tokenHash(tokens.bob)}];
  const app=createApp({database:join(dir,'queue.sqlite'),auth});
  await new Promise<void>(done=>app.http.listen(0,'127.0.0.1',done));
  const port=(app.http.address() as {port:number}).port;
  let prompts=0,failedBefore=false,failedAfter=false; const seen=new Map<string,number>();
  const proxy=createServer(async(req,res)=>{
    try {
      let body='';for await(const chunk of req)body+=chunk;
      const data=body?JSON.parse(body):undefined;
      const isDraft=req.url?.endsWith('/update')&&data?.kind==='draft';
      const count=isDraft?(seen.get(req.url!)??0)+1:0;
      if(isDraft)seen.set(req.url!,count);
      if(isDraft&&!failedBefore){failedBefore=true;res.writeHead(503,{'Content-Type':'application/json'});return res.end('{}');}
      const response=await fetch(`http://127.0.0.1:${port}${req.url}`,{
        method:req.method,headers:{'Content-Type':'application/json',Authorization:req.headers.authorization??''},...(body?{body}:{})
      });
      const text=await response.text();
      if(isDraft&&response.ok&&seen.size===2&&!failedAfter){failedAfter=true;res.writeHead(503,{'Content-Type':'application/json'});return res.end('{}');}
      res.writeHead(response.status,{'Content-Type':'application/json'});res.end(text);
    }catch{res.writeHead(500);res.end('{}');}
  });
  await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));
  const mock=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    const path=new URL(req.url!,'http://localhost').pathname;
    if(path==='/global/health')return res.end('{"healthy":true}');
    if(path==='/agent')return res.end('[{"name":"queue-reader"}]');
    if(path==='/session')return res.end(JSON.stringify({id:randomUUID()}));
    for await(const _chunk of req) { /* consume the prompt */ }
    prompts++;res.end(JSON.stringify({info:{},parts:[{type:'text',text:`saved answer ${prompts}`}]}));
  });
  await new Promise<void>(done=>mock.listen(0,'127.0.0.1',done));
  const alice:Actor={id:'alice',name:'A',role:'human'},bob:Actor={id:'bob',name:'B',role:'human'};
  const tasks=[1,2].map(n=>{
    const task=app.store.create(alice,createSchema.parse({recipient:'bob',title:`retry ${n}`,body:'read',idempotencyKey:randomUUID()}));
    app.store.act(bob,task.id,'approve');return task;
  });
  const stateDir=join(dir,'outbox');
  const manager=new Manager(managerSchema.parse({serverUrl:`http://127.0.0.1:${(proxy.address() as {port:number}).port}`,
    workerToken:tokens.bob,opencodeUrl:`http://127.0.0.1:${(mock.address() as {port:number}).port}`,directory:dir,reconcileMs:1000}),stateDir);
  try {
    await manager.start();
    await waitFor(async()=>tasks.every(task=>app.store.get(bob,task.id).state==='draft')&&
      !readdirSync(stateDir,{recursive:true,withFileTypes:true}).some(file=>file.name.endsWith('.json')));
    assert(failedBefore);assert(failedAfter);assert.equal(prompts,2);
    assert.equal(app.store.get(bob,tasks[0].id).draft,'saved answer 1');
    assert.equal(app.store.get(bob,tasks[1].id).draft,'saved answer 2');
  }finally{
    await manager.stop();
    for(const server of [proxy,mock])await new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections();});
    await app.close();rmSync(dir,{recursive:true,force:true});
  }
});
