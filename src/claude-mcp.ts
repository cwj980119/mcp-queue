import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export function expandEnvironment(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    const result = process.env[name] ?? fallback;
    if (result === undefined) throw new Error(`Missing document MCP environment variable: ${name}`);
    return result;
  });
  if (Array.isArray(value)) return value.map(expandEnvironment);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,expandEnvironment(item)]));
  return value;
}

// Only selected document tools cross this proxy. CLI allowedTools alone is not a tool inventory filter.
export function createToolProxy(client: Client, allowedNames: string[]) {
  const allowed = new Set(allowedNames);
  const server = new Server({name:'queue-document-tools',version:'0.1.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];
    let cursor: string | undefined;
    for (let page=0;page<20;page++) {
      const result=await client.listTools(cursor?{cursor}:{});
      tools.push(...result.tools.filter(tool=>allowed.has(tool.name)));
      cursor=result.nextCursor;if(!cursor)break;
    }
    return {tools};
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if(!allowed.has(request.params.name)) return {isError:true,content:[{type:'text',text:'Tool is not allowed for this queue run.'}]};
    try{return await client.callTool({name:request.params.name,arguments:request.params.arguments});}
    catch{return {isError:true,content:[{type:'text',text:'Document MCP call failed. Check local access and authentication.'}]};}
  });
  return server;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [, , configPath, serverName, namesJson]=process.argv;
  const allowed=z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).min(1).parse(JSON.parse(namesJson));
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  const source=z.record(z.string(),z.unknown()).parse(expandEnvironment(config.mcpServers?.[serverName]));
  const client=new Client({name:'queue-document-proxy',version:'0.1.0'});
  if(source.type==='http'||source.type==='sse') {
    const url=new URL(z.string().parse(source.url));
    if(!['http:','https:'].includes(url.protocol))throw new Error('Document MCP URL must use HTTP or HTTPS.');
    const headers=z.record(z.string(),z.string()).default({}).parse(source.headers);
    const options={requestInit:{headers}};
    await client.connect(source.type==='http'?new StreamableHTTPClientTransport(url,options):new SSEClientTransport(url,options));
  }else{
    const command=z.string().min(1).parse(source.command);
    if(/\.(cmd|bat|ps1)$/i.test(command))throw new Error('Use a native executable or node script for the document MCP.');
    const args=z.array(z.string()).default([]).parse(source.args);
    const env=z.record(z.string(),z.string()).default({}).parse(source.env);
    await client.connect(new StdioClientTransport({command,args,env:{...process.env,...env} as Record<string,string>,stderr:'ignore'}));
  }
  const proxy=createToolProxy(client,allowed);
  await proxy.connect(new StdioServerTransport());
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await proxy.close();await client.close();};
  process.stdin.once('end',()=>{void close();});
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void close().finally(()=>process.exit(0));});
}
