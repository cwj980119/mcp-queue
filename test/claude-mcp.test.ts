import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createToolProxy, expandEnvironment } from '../src/claude-mcp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Claude document proxy hides unapproved tools and rejects direct forbidden calls',async()=>{
  const upstream=new Server({name:'fixture-docs',version:'1'},{capabilities:{tools:{}}});
  let writes=0;
  upstream.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['read','delete_document'].map(name=>({name,inputSchema:{type:'object'}}))}));
  upstream.setRequestHandler(CallToolRequestSchema,async req=>{if(req.params.name==='delete_document')writes++;return {content:[{type:'text',text:'document text'}]};});
  const internal=new Client({name:'proxy-upstream',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();await upstream.connect(left);await internal.connect(right);
  const proxy=createToolProxy(internal,['read']);
  const external=new Client({name:'claude-fixture',version:'1'});
  const [front,back]=InMemoryTransport.createLinkedPair();await proxy.connect(front);await external.connect(back);
  try{
    assert.deepEqual((await external.listTools()).tools.map(tool=>tool.name),['read']);
    assert(!(await external.callTool({name:'read',arguments:{}})).isError);
    assert((await external.callTool({name:'delete_document',arguments:{}})).isError);assert.equal(writes,0);
  }finally{await external.close();await proxy.close();await internal.close();await upstream.close();}
});
test('document MCP environment expansion supports defaults and never silently drops missing credentials',()=>{
  assert.deepEqual(expandEnvironment({headers:{Authorization:'Bearer ${QUEUE_TEST_NONEXISTENT_VAR:-test-only}'}}),{headers:{Authorization:'Bearer test-only'}});
  assert.throws(()=>expandEnvironment('${QUEUE_TEST_NONEXISTENT_VAR}'),/Missing document MCP environment variable/);
});
test('actual stdio proxy process connects to a document MCP and filters its tools',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'queue-doc-proxy-'));const path=join(dir,'docs.json');
  writeFileSync(path,JSON.stringify({mcpServers:{corpdocs:{command:process.execPath,args:[resolve('test/fixtures/docs-mcp.mjs')]}}}));
  const client=new Client({name:'stdio-proxy-test',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/src/claude-mcp.js'),path,'corpdocs','["read"]'],stderr:'ignore'}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['read']);
    const result=await client.callTool({name:'read',arguments:{}});assert.match(JSON.stringify(result),/DOC-42/);
    assert((await client.callTool({name:'delete_document',arguments:{}})).isError);
  }finally{await client.close();rmSync(dir,{recursive:true,force:true});}
});
