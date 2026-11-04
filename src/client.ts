import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { connectionSchema, readConnection, type Connection } from './connection.js';
import { managerSchema, type ManagerConfig } from './config.js';
import { Manager } from './manager.js';
import { detectRuntimes, validProject, executableCommand, readJsonc, claudeSources, registerQueue, savePrivate } from './local-config.js';
import { startOpenCode, verifyReadProfile, discoverTools, type LocalOpenCode } from './local-runtime.js';

type Runtime='opencode'|'claude-code';
type FoundTool={name:string;description:string;recommended:boolean};
type Context={runtime:Runtime;directory:string;command:string[];servers:Record<string,any>;
  tools:Record<string,FoundTool[]>;providerSettings?:{env:Record<string,string>;apiKeyHelper?:string};model?:string};
export function createClientApp(options:{stateDir?:string;home?:string;commands?:Partial<Record<Runtime,string[]>>}={}) {
  const home=options.home??homedir();const stateDir=resolve(options.stateDir??process.env.QUEUE_CLIENT_HOME??join(home,'.mcp-queue'));
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  let connection:Connection|undefined;
  const profileDir=()=>join(stateDir,connection?createHash('sha256').update(connection.serverUrl+connection.userId).digest('hex').slice(0,24):'unconfigured');
  const saved=(name:string)=>name==='connection.json'?join(stateDir,name):join(profileDir(),name);
  try{connection=readConnection(readFileSync(saved('connection.json'),'utf8'));}catch{}
  let context:Context|undefined;let local:LocalOpenCode|undefined;let manager:Manager|undefined;let busy=false;
  let message='';let backups:string[]=[];
  const commands={...detectRuntimes(home),...options.commands};
  const key=randomBytes(32).toString('base64url');
  const app=express();app.disable('x-powered-by');
  const publicRoot=fileURLToPath(new URL('../../client-public/',import.meta.url));
  app.use((req,res,next)=>{
    const allowed=new Set([`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`]);
    if(!allowed.has(req.headers.host??''))return res.status(403).end();
    if(req.headers.origin){try{if(!allowed.has(new URL(req.headers.origin).host))return res.status(403).end();}catch{return res.status(403).end();}}
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");next();
  });
  app.get('/',(_req,res)=>res.type('html').send(readFileSync(join(publicRoot,'index.html'),'utf8').replace('CLIENT_KEY',key)));
  app.get('/client-info',(_req,res)=>res.json({name:'mcp-queue-client',pid:process.pid}));
  app.use(express.static(publicRoot,{index:false}));app.use(express.json({limit:'32kb'}));
  app.use('/api',(req,res,next)=>{if(req.headers['x-client-key']!==key)return res.status(403).json({error:'연결 창을 새로고침하세요.'});next();});
  const view=()=>({
    identity:connection?{id:connection.userId,name:connection.name,serverUrl:connection.serverUrl}:null,
    installed:Object.fromEntries(Object.entries(commands).map(([runtime,command])=>[runtime,!!command])),
    configured:existsSync(saved('manager.json')),running:!!manager,status:manager?.status()??{connected:false,working:false},
    busy,message,backups,
    project:context?{runtime:context.runtime,directory:context.directory,servers:Object.keys(context.servers).filter(name=>name!=='queue')}:null,
    choice:existsSync(saved('choice.json'))?readJsonc(saved('choice.json')):null
  });
  const requireConnection=()=>{if(!connection)throw new Error('먼저 Queue 웹에서 발급받은 내 PC 연결 파일을 불러오세요.');return connection;};
  const verify=async(value:Connection)=>{
    const roles=value.version===1?['human','agent','worker'] as const:['agent','worker'] as const;
    await Promise.all(roles.map(async role=>{
      let response:Response;
      try{response=await fetch(new URL('/api/me',value.serverUrl),{headers:{Authorization:`Bearer ${value[`${role}Token`]}`},signal:AbortSignal.timeout(7000)});}
      catch{throw new Error('서버에 연결하지 못했습니다. 서버 주소와 네트워크를 확인하세요.');}
      if(!response.ok)throw new Error('서버가 연결 파일을 확인하지 못했습니다. Queue 웹에 로그인하고 PC 연결 파일을 다시 발급받으세요.');
      const identity=await response.json() as {id:string;role:string};
      if(identity.id!==value.userId||identity.role!==role)throw new Error('연결 파일의 사용자 정보가 일치하지 않습니다.');
    }));
  };
  const stop=async()=>{if(manager){const old=manager;manager=undefined;await old.stop();}if(local){const old=local;local=undefined;await old.stop();}};
  const operation=(fn:(body:any)=>Promise<unknown>)=>async(req:express.Request,res:express.Response,next:express.NextFunction)=>{
    if(busy)return res.status(409).json({error:'이전 작업이 끝날 때까지 기다려주세요.'});busy=true;
    try{const result=await fn(req.body);res.json(result??view());}catch(error){next(error);}finally{busy=false;}
  };
  app.get('/api/state',(_req,res)=>res.json(view()));
  app.post('/api/import',operation(async body=>{
    if(manager)throw new Error('실행을 중지한 뒤 연결 파일을 바꿔주세요.');
    const input=z.object({text:z.string(),serverUrl:z.string().optional()}).parse(body);
    const value=readConnection(input.text);
    if(input.serverUrl)value.serverUrl=input.serverUrl.replace(/\/$/,'');
    connectionSchema.parse(value);await verify(value);
    await stop();connection=value;context=undefined;savePrivate(saved('connection.json'),value);
    message='본인 계정이 연결되었습니다. 사용할 도구와 프로젝트 폴더를 선택하세요.';return view();
  }));
  app.post('/api/inspect',operation(async body=>{
    requireConnection();if(manager)throw new Error('실행을 중지한 뒤 설정을 변경하세요.');
    const input=z.object({runtime:z.enum(['opencode','claude-code']),directory:z.string(),executable:z.string().optional()}).parse(body);
    const directory=validProject(input.directory);
    const command=input.executable?executableCommand(input.executable):commands[input.runtime];
    if(!command)throw new Error(`${input.runtime==='opencode'?'OpenCode':'Claude Code'} 설치를 찾지 못했습니다. 설치 후 다시 열거나 고급 설정에서 실행 파일을 선택하세요.`);
    await stop();context=undefined;
    if(input.runtime==='opencode'){
      local=await startOpenCode(command,directory);
      let config:any;
      try{config=await local.call('/config');}catch(error){await stop();throw error;}
      context={runtime:input.runtime,directory,command,servers:config.mcp??{},tools:{}};
    }else{
      const source=claudeSources(directory,home);
      context={runtime:input.runtime,directory,command,servers:source.servers,tools:{},providerSettings:source.providerSettings,model:source.model};
    }
    message='프로젝트 설정을 찾았습니다. 기존에 쓰던 문서 서비스를 선택하세요.';return view();
  }));
  app.post('/api/tools',operation(async body=>{
    const server=z.object({server:z.string().min(1).max(100)}).parse(body).server;
    if(!context||server==='queue'||!Object.hasOwn(context.servers,server))throw new Error('문서 서비스를 먼저 선택하세요.');
    let tools;
    try{tools=await discoverTools(context.servers[server],context.providerSettings?.env);}catch{throw new Error('문서 서비스에 연결하지 못했습니다. 평소 에이전트에서 해당 서비스의 로그인 상태를 확인하세요. OAuth 전용 서비스는 추가 연동이 필요할 수 있습니다.');}
    const found=tools.map(tool=>({name:tool.name,description:(tool.description??tool.name).slice(0,500),
      recommended:tool.annotations?.readOnlyHint===true||(!/write|delete|update|create|send|move|add|remove|publish/i.test(tool.name)&&/search|list|get|fetch|read|lookup|검색|조회/i.test(tool.name))}));
    context.tools[server]=found;return {tools:found};
  }));
  app.post('/api/connect',operation(async body=>{
    const value=requireConnection();if(!context||manager)throw new Error('프로젝트를 먼저 확인하세요.');
    const input=z.object({server:z.string(),tools:z.array(z.string()).min(1).max(30)}).parse(body);
    if(!Object.hasOwn(context.tools,input.server)||input.tools.some(name=>!context!.tools[input.server].some(tool=>tool.name===name)))throw new Error('목록에 표시된 문서 기능을 선택하세요.');
    const own=context;
    const names=input.tools.map(name=>own.runtime==='opencode'?`${input.server}_${name}`:`mcp__${input.server}__${name}`);
    const registered=registerQueue(own.runtime,value,names,profileDir(),home);backups=registered.backup?[registered.backup]:[];
    let config:ManagerConfig;
    if(own.runtime==='opencode'){
      await stop();local=await startOpenCode(own.command,own.directory,registered.overlay);
      await verifyReadProfile(local,names);
      config=managerSchema.parse({runtime:'opencode',serverUrl:value.serverUrl,workerToken:value.workerToken,directory:own.directory,
        opencodeUrl:local.url,opencodePassword:local.password,agent:'queue-reader'});
    }else{
      const docs=saved('document-mcp.json');savePrivate(docs,{mcpServers:{[input.server]:own.servers[input.server]}});
      config=managerSchema.parse({runtime:'claude-code',serverUrl:value.serverUrl,workerToken:value.workerToken,directory:own.directory,
        claude:{command:own.command,mcpConfig:docs,allowedTools:names,providerSettings:own.providerSettings,model:own.model}});
    }
    savePrivate(saved('manager.json'),config);savePrivate(saved('choice.json'),{runtime:own.runtime,directory:own.directory,server:input.server,command:own.command,tools:names});
    const nextManager=new Manager(config,saved('outbox'));
    try{await nextManager.start();manager=nextManager;}catch{await nextManager.stop();throw new Error('PC 설정은 저장했습니다. 서버 접속을 확인한 뒤 시작 버튼을 눌러주세요.');}
    message='연결 완료! 이제 요청함에서 승인한 업무를 이 PC가 처리합니다.';return view();
  }));
  app.post('/api/start',operation(async()=>{
    const value=requireConnection();if(manager)return view();
    await verify(value);let config=managerSchema.parse(readJsonc(saved('manager.json')));
    config={...config,serverUrl:value.serverUrl,workerToken:value.workerToken};
    const previous=readJsonc(saved('choice.json'));
    const registered=Array.isArray(previous.tools)?registerQueue(config.runtime,value,previous.tools,profileDir(),home):undefined;
    if(config.runtime==='opencode'){
      const choice=readJsonc(saved('choice.json'));await stop();local=await startOpenCode(z.array(z.string()).min(1).parse(choice.command),validProject(config.directory),registered?.overlay);
      await verifyReadProfile(local,previous.tools??[]);
      config={...config,opencodeUrl:local.url,opencodePassword:local.password};savePrivate(saved('manager.json'),config);
    }else{
      const source=claudeSources(config.directory,home);
      config={...config,claude:{...config.claude,providerSettings:source.providerSettings,model:source.model??config.claude.model}};
    }
    const nextManager=new Manager(config,saved('outbox'));try{await nextManager.start();manager=nextManager;}catch{await nextManager.stop();await stop();throw new Error('시작하지 못했습니다. 서버와 에이전트 연결을 확인하세요.');}
    message='승인된 업무를 기다리고 있습니다.';return view();
  }));
  app.post('/api/stop',operation(async()=>{await stop();message='중지했습니다. 서버의 요청과 PC 설정은 보관됩니다.';return view();}));
  app.post('/api/login',(_req,res)=>{
    const value=requireConnection();const url=new URL('/',value.serverUrl);if(value.version===1)url.hash=`login=${encodeURIComponent(value.humanToken!)}`;res.json({url:url.href});
  });
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    res.status(400).json({error:error instanceof z.ZodError?'입력 내용을 확인해주세요.':error instanceof Error?error.message:'연결 중 오류가 발생했습니다.'});
  });
  const http=createServer(app);
  return {app,http,key,stateDir,view,close:async()=>{await stop();await new Promise<void>(done=>{http.close(()=>done());http.closeAllConnections();});}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const instance=createClientApp();
  instance.http.listen(Number(process.env.QUEUE_CLIENT_PORT??3210),'127.0.0.1',()=>{
    const address=instance.http.address();const port=typeof address==='object'&&address?address.port:3210;const url=`http://127.0.0.1:${port}`;
    console.log(`MCP Queue PC 연결: ${url}\n이 창을 켜 두세요. 에이전트 설정은 브라우저에서 진행합니다.`);
    if(process.env.QUEUE_NO_OPEN_BROWSER!=='1'){
      const command=process.platform==='win32'?['rundll32.exe','url.dll,FileProtocolHandler',url]:process.platform==='darwin'?['open',url]:['xdg-open',url];
      const child=spawn(command[0],command.slice(1),{stdio:'ignore',detached:true,windowsHide:true});child.on('error',()=>{});child.unref();
    }
  });
  instance.http.on('error',()=>{console.error('PC 연결 프로그램을 시작하지 못했습니다. 이미 실행 중인지 확인하세요.');process.exitCode=1;});
  let closing=false;
  const close=()=>{if(closing)return;closing=true;void instance.close().then(()=>process.exit(0));};
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,close);
  if(process.env.QUEUE_DESKTOP_HOST==='1'){
    let input='';process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>{input+=chunk;if(input.length>100){input='';return;}if(input.includes('\n')){if(input.trim()==='quit')close();input='';}});
    process.stdin.on('end',close);
  }
}
