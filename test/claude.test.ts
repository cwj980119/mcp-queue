import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { managerSchema } from '../src/config.js';
import { ClaudeCodeAdapter } from '../src/claude.js';
import { createSchema } from '../src/types.js';
import { Store } from '../src/store.js';

const root=mkdtempSync(join(tmpdir(),'queue-claude-'));const mcpConfig=join(root,'docs.json');
writeFileSync(mcpConfig,JSON.stringify({mcpServers:{corpdocs:{type:'http',url:'http://127.0.0.1:1/mcp'}}}));
const config=(mode='success')=>{
  const parsed=managerSchema.parse({runtime:'claude-code',serverUrl:'http://localhost:3000',workerToken:'fixture-token-'.repeat(3),directory:root,
    claude:{command:[process.execPath,resolve('test/fixtures/claude-cli.mjs'),'--fixture-mode',mode,'--fixture-log',join(root,`${mode}.jsonl`)],
      mcpConfig,allowedTools:['mcp__corpdocs__get_document']}});
  assert.equal(parsed.runtime,'claude-code');return parsed;
};
const store=new Store(':memory:',[{id:'alice',name:'A'},{id:'bob',name:'B'}]);
const malicious='Question with shell syntax: $(echo SHOULD_NOT_EXECUTE) & whoami | more';
const task=store.create({id:'alice',name:'A',role:'human'},createSchema.parse({recipient:'bob',title:'test',body:malicious,idempotencyKey:randomUUID()}));
test.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
test('Claude receives task only through stdin, uses bounded read-only flags, saves its session before execution',async()=>{
  let session='';const adapter=new ClaudeCodeAdapter(config());
  const draft=await adapter.execute(task,async id=>{session=id;},new AbortController().signal);
  assert.match(draft,/DOC-42/);assert.match(session,/^claude-code:[0-9a-f-]{36}$/);
  const invocation=JSON.parse(readFileSync(join(root,'success.jsonl'),'utf8'));
  assert(invocation.prompt.includes(malicious));assert(!invocation.argv.some((arg:string)=>arg.includes(malicious)));
});
for(const mode of ['error','bad-json','wrong-session','denied','empty','exit'])test(`Claude fails safely on ${mode}`,async()=>{
  await assert.rejects(()=>new ClaudeCodeAdapter(config(mode)).execute(task,async()=>{},new AbortController().signal),
    (error:Error)=>{assert(!error.message.includes('PRIVATE_DIAGNOSTIC'));return true;});
});
test('Claude abort waits for the child process to exit',async()=>{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),350);
  try{await assert.rejects(()=>new ClaudeCodeAdapter(config('hang')).execute(task,async()=>{},controller.signal),/interrupted/);}
  finally{clearTimeout(timer);}
});
test('old OpenCode configuration is compatible and Claude tool wildcards are rejected',()=>{
  assert.equal(managerSchema.parse({serverUrl:'http://localhost:3000',workerToken:'x'.repeat(30),directory:root}).runtime,'opencode');
  assert.throws(()=>managerSchema.parse({...config(),claude:{...config().claude,allowedTools:['mcp__corpdocs__*']}}));
  assert.throws(()=>new ClaudeCodeAdapter({...config(),claude:{...config().claude,mcpConfig:'relative.json'}}),/absolute/);
});
