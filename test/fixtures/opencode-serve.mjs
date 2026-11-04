import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { randomUUID } from 'node:crypto';
const argv=process.argv.slice(2);const value=name=>argv[argv.indexOf(name)+1];
const global=join(value('--fixture-home'),'.config','opencode','opencode.json');
const local=JSON.parse(readFileSync(join(process.cwd(),'opencode.json'),'utf8'));
const configuration=()=>{const value=existsSync(global)?parse(readFileSync(global,'utf8')):{};const inline=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT??'{}');return {...value,...inline,agent:{...value.agent,...local.agent,...inline.agent}};};
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  const expected=`Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
  if(req.headers.authorization!==expected){res.writeHead(401);return res.end('{}');}
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/global/health')return res.end('{"healthy":true}');
  if(path==='/config')return res.end(JSON.stringify({mcp:{...configuration().mcp,...local.mcp}}));
  if(path==='/agent')return res.end(JSON.stringify(Object.entries(configuration().agent??{}).map(([name,config])=>({name,
    permission:Object.entries(config.permission??{}).map(([permission,action])=>({permission,pattern:'*',action}))}))));
  if(path==='/session')return res.end(JSON.stringify({id:`ses_${randomUUID()}`}));
  if(/^\/session\/[^/]+\/message$/.test(path)){
    for await(const _chunk of req){}
    return res.end(JSON.stringify({info:{},parts:[{type:'text',text:'DOC-42 document answer (fixture)'}]}));
  }
  res.writeHead(404);res.end('{}');
});
server.listen(Number(value('--port')),'127.0.0.1');
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
