import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, rmdirSync, chownSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { serverAddress } from './server-address.mjs';

const root=resolve(process.env.QUEUE_SETUP_DIR??'.local');
const address=serverAddress();
process.env.QUEUE_SERVER_URL=address.url;
mkdirSync(root,{recursive:true,mode:0o700});
writeFileSync(join(root,'server-address.txt'),address.url+'\n',{mode:0o644});
console.log(`Queue server address: ${address.url}`);
if(address.mode==='local')console.log('Local-only binding: these connection files work on this PC only. Use the server start file for other PCs.');
// Older bind mounts can leave an empty directory at a missing file path. Never remove a non-empty directory.
const legacyAuth=join(root,'auth.json');
if(existsSync(legacyAuth)&&statSync(legacyAuth).isDirectory())rmdirSync(legacyAuth);
if(!existsSync(join(root,'auth.json')))await import('./setup.mjs');
const entries=JSON.parse(readFileSync(join(root,'auth.json'),'utf8'));
// Mount only hashes into the service. A directory bind works before first bootstrap creates the file.
const serverAuth=join(root,'server-auth');mkdirSync(serverAuth,{recursive:true,mode:0o755});chmodSync(serverAuth,0o755);
writeFileSync(join(serverAuth,'auth.json'),JSON.stringify(entries,null,2)+'\n',{mode:0o644});chmodSync(join(serverAuth,'auth.json'),0o644);
const folder=join(root,'connections');mkdirSync(folder,{recursive:true,mode:0o700});
for(const id of [...new Set(entries.map(entry=>entry.id))]){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw new Error('Invalid user ID in auth.json');
  const file=join(folder,`${id}.queue.json`);
  try{
    const manager=JSON.parse(readFileSync(join(root,id,'manager.json'),'utf8'));
    const mcp=JSON.parse(readFileSync(join(root,id,'opencode-mcp.json'),'utf8'));
    const tokens={human:readFileSync(join(root,id,'human-token.txt'),'utf8').trim(),
      agent:mcp.mcp.queue.headers.Authorization.replace(/^Bearer /,''),worker:manager.workerToken};
    if(!Object.entries(tokens).every(([role,token])=>entries.some(entry=>entry.id===id&&entry.role===role&&entry.tokenHash===createHash('sha256').update(token).digest('hex'))))
      throw new Error('credential mismatch');
    const serverUrl=address.url;
    const data={version:1,serverUrl,userId:id,name:entries.find(entry=>entry.id===id).name,
      humanToken:tokens.human,agentToken:tokens.agent,workerToken:tokens.worker};
    const text=JSON.stringify(data,null,2)+'\n';
    if(!existsSync(file)||readFileSync(file,'utf8')!==text)writeFileSync(file,text,{mode:0o600});
    // Keep older server-issued bundles consistent too, without changing tokens or local task settings.
    const sync=(name,value)=>{
      const path=join(root,id,name);const next=JSON.stringify(value,null,2)+'\n';
      if(readFileSync(path,'utf8')!==next)writeFileSync(path,next,{mode:0o600});
    };
    sync('manager.json',{...manager,serverUrl});
    sync('opencode-mcp.json',{...mcp,mcp:{...mcp.mcp,queue:{...mcp.mcp.queue,url:new URL('/mcp',serverUrl).href}}});
    for(const name of ['manager.claude.json','claude-mcp.json']){
      const path=join(root,id,name);if(!existsSync(path))continue;
      const value=JSON.parse(readFileSync(path,'utf8'));
      sync(name,name==='manager.claude.json'?{...value,serverUrl}:{...value,mcpServers:{...value.mcpServers,queue:{...value.mcpServers.queue,url:new URL('/mcp',serverUrl).href}}});
    }
    chmodSync(file,0o600);
    console.log(`Connection file ready: .local/connections/${id}.queue.json (give it only to ${id})`);
  }catch{
    console.log(`Existing credentials for ${id} preserved. Connection file ${existsSync(file)?'already exists':'requires the original user bundle'}.`);
  }
}
// Docker may create directory bind sources as root before bootstrap starts.
// Return only known setup files to the workspace owner; never recursively chown user data.
if(process.getuid?.()===0){
  const workspace=statSync(process.cwd());
  const uid=Number(process.env.QUEUE_UID||workspace.uid),gid=Number(process.env.QUEUE_GID||workspace.gid);
  if(!Number.isSafeInteger(uid)||uid<0||!Number.isSafeInteger(gid)||gid<0)throw new Error('Invalid setup owner');
  const paths=[root,legacyAuth,serverAuth,join(serverAuth,'auth.json'),folder];
  for(const id of [...new Set(entries.map(entry=>entry.id))]){
    paths.push(join(folder,`${id}.queue.json`),join(root,id));
    for(const name of ['human-token.txt','manager.json','opencode-mcp.json','claude-mcp.json','manager.claude.json'])paths.push(join(root,id,name));
  }
  for(const path of paths)if(existsSync(path))chownSync(path,uid,gid);
}
