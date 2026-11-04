import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// Derive Claude configuration from an existing user bundle, without rotating server credentials.
const folder = process.argv[2];
if (!folder) throw new Error('Usage: npm run config:claude -- .local/bob');
for (const name of ['claude-mcp.json','manager.claude.json']) if (existsSync(join(folder,name))) throw new Error(`${name} exists; refusing to overwrite.`);
const manager = JSON.parse(readFileSync(join(folder,'manager.json'),'utf8'));
const mcp = JSON.parse(readFileSync(join(folder,'opencode-mcp.json'),'utf8'));
const queue = mcp.mcp.queue;
const save = (name,value) => writeFileSync(join(folder,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
save('claude-mcp.json',{mcpServers:{queue:{type:'http',url:queue.url,headers:queue.headers}}});
save('manager.claude.json',{
  runtime:'claude-code',serverUrl:manager.serverUrl,workerToken:manager.workerToken,directory:manager.directory,
  claude:{command:[process.platform==='win32'?'claude.exe':'claude'],mcpConfig:'REPLACE_WITH_ABSOLUTE_DOCUMENT_MCP_CONFIG_FILE',
    allowedTools:['mcp__corpdocs__search_documents','mcp__corpdocs__get_document'],maxTurns:12},
  timeoutMs:manager.timeoutMs??600000,reconcileMs:manager.reconcileMs??60000
});
console.log('Created Claude Code configuration using the existing user tokens. Edit directory, MCP file path and document tool names.');
