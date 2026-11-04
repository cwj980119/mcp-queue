import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { expandEnvironment } from './claude-mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { parse } from 'jsonc-parser';

export type LocalOpenCode={child:ChildProcess;url:string;password:string;call:(path:string)=>Promise<any>;stop:()=>Promise<void>};
export async function stopChild(child:ChildProcess) {
  if(child.pid===undefined||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>(done=>{const force=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('close',()=>{clearTimeout(force);done();});child.kill('SIGTERM');});
}
export async function startOpenCode(command:string[],directory:string,overlay?:Record<string,any>):Promise<LocalOpenCode> {
  const port=await new Promise<number>((done,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
    const address=server.address();const port=typeof address==='object'&&address?address.port:0;server.close(()=>done(port));});});
  const password=randomBytes(32).toString('base64url');const url=`http://127.0.0.1:${port}`;
  const inherited=parse(process.env.OPENCODE_CONFIG_CONTENT??'{}');
  const content=overlay?JSON.stringify({...inherited,mcp:{...inherited?.mcp,...overlay.mcp},agent:{...inherited?.agent,...overlay.agent}}):process.env.OPENCODE_CONFIG_CONTENT;
  const child=spawn(command[0],[...command.slice(1),'serve','--hostname','127.0.0.1','--port',String(port)],{
    cwd:directory,shell:false,windowsHide:true,stdio:['ignore','ignore','ignore'],
    env:{...process.env,OPENCODE_SERVER_PASSWORD:password,OPENCODE_SERVER_USERNAME:'opencode',...(content?{OPENCODE_CONFIG_CONTENT:content}:{})}
  });
  let failure=false;child.on('error',()=>{failure=true;});
  const call=async(path:string)=>{const response=await fetch(new URL(path,url),{headers:{Authorization:`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`},signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error('OpenCode에서 설정을 읽지 못했습니다.');return response.json();};
  for(let attempt=0;attempt<80;attempt++){
    if(failure||child.exitCode!==null){await stopChild(child);throw new Error('OpenCode를 시작하지 못했습니다. 설치와 프로젝트 설정을 확인하세요.');}
    try{const health=await call('/global/health');if(health.healthy)return {child,url,password,call,stop:()=>stopChild(child)};}catch{}
    await new Promise(done=>setTimeout(done,250));
  }
  await stopChild(child);throw new Error('OpenCode 시작 시간이 초과되었습니다. 회사 네트워크와 기존 설정을 확인하세요.');
}
export async function verifyReadProfile(local:LocalOpenCode,tools:string[]) {
  const agents=await local.call('/agent');
  const reader=Array.isArray(agents)?agents.find(agent=>agent.name==='queue-reader'):undefined;
  const rules=reader?.permission;
  if(!Array.isArray(rules))throw new Error('OpenCode의 읽기 프로필 권한을 확인하지 못했습니다. 지원되는 OpenCode 버전인지 확인하세요.');
  const boundary=rules.findLastIndex(rule=>rule.permission==='*'&&rule.pattern==='*');
  if(boundary<0||rules[boundary].action!=='deny'||rules.slice(boundary+1).some(rule=>rule.action!=='deny'&&rule.permission!=='external_directory'&&!tools.includes(rule.permission)))
    throw new Error('프로젝트 또는 회사 정책이 읽기 프로필을 변경했습니다. 관리자에게 권한 설정을 확인해주세요.');
}
export function normalizeMcp(source:Record<string,any>):Record<string,any> {
  if(source.type==='remote')return {type:'http',url:source.url,headers:source.headers};
  if(source.type==='local')return {command:source.command?.[0],args:source.command?.slice(1),env:source.environment};
  return source;
}
export async function discoverTools(source:Record<string,any>,env:Record<string,string>={}):Promise<Tool[]> {
  const config=expandEnvironment(normalizeMcp(source),{...process.env,...env}) as Record<string,any>;
  const client=new Client({name:'queue-setup',version:'1'});
  try{
    if(config.type==='http'||config.type==='sse'){
      const url=new URL(config.url);if(!['http:','https:'].includes(url.protocol))throw new Error('지원하지 않는 문서 서비스 주소입니다.');
      const options={requestInit:{headers:config.headers??{}}};
      await client.connect(config.type==='http'?new StreamableHTTPClientTransport(url,options):new SSEClientTransport(url,options),{timeout:15000});
    }else{
      if(typeof config.command!=='string'||/\.(cmd|bat|ps1)$/i.test(config.command))throw new Error('문서 서비스의 네이티브 실행 파일이 필요합니다.');
      await client.connect(new StdioClientTransport({command:config.command,args:config.args??[],
        env:{...process.env,...env,...config.env} as Record<string,string>,stderr:'ignore'}),{timeout:15000});
    }
    const tools:Tool[]=[];let cursor:string|undefined;
    for(let page=0;page<20;page++){const result=await client.listTools(cursor?{cursor}:{});tools.push(...result.tools);cursor=result.nextCursor;if(!cursor)break;}
    return tools;
  }finally{await client.close();}
}
