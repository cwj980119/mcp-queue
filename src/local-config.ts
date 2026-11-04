import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, copyFileSync, constants, chmodSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { randomUUID } from 'node:crypto';
import type { Connection } from './connection.js';

export function readJsonc(path: string): Record<string, any> {
  if(!existsSync(path))return {};
  if(statSync(path).size>2*1024*1024)throw new Error('설정 파일이 너무 큽니다.');
  const errors:ParseError[]=[];const value=parse(readFileSync(path,'utf8'),errors,{allowTrailingComma:true});
  if(errors.length||!value||typeof value!=='object'||Array.isArray(value))throw new Error(`기존 설정 파일을 읽을 수 없습니다: ${path}`);
  return value;
}
export function updateJsonc(path: string, changes:{path:string[];value:unknown}[]):string|undefined {
  readJsonc(path);const original=existsSync(path)?readFileSync(path,'utf8'):'{}\n';let text=original;
  for(const change of changes)text=applyEdits(text,modify(text,change.path,change.value,{formattingOptions:{insertSpaces:true,tabSize:2}}));
  if(text===original)return;
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  let backup:string|undefined;
  if(existsSync(path)){backup=`${path}.mcp-queue-backup-${Date.now()}-${randomUUID().slice(0,6)}`;
    copyFileSync(path,backup,constants.COPYFILE_EXCL);chmodSync(backup,0o600);}
  const temp=`${path}.queue-${randomUUID()}.tmp`;writeFileSync(temp,text,{mode:0o600});renameSync(temp,path);
  return backup;
}
export function savePrivate(path:string,value:unknown) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.queue-${randomUUID()}.tmp`;
  writeFileSync(temp,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temp,path);chmodSync(path,0o600);
}
export function opencodeConfigFile(home=homedir()):string {
  const root=home===homedir()&&process.env.XDG_CONFIG_HOME?join(process.env.XDG_CONFIG_HOME,'opencode'):join(home,'.config','opencode');
  return existsSync(join(root,'opencode.jsonc'))?join(root,'opencode.jsonc'):join(root,'opencode.json');
}
export function claudeSources(project:string,home=homedir()) {
  const custom=home===homedir()?process.env.CLAUDE_CONFIG_DIR:undefined;
  const root=custom??join(home,'.claude');
  const globalPath=custom?join(root,'.claude.json'):join(home,'.claude.json');
  const user=readJsonc(globalPath), workspace=readJsonc(join(project,'.mcp.json'));
  const local=user.projects?.[project]?.mcpServers??user.projects?.[project.replaceAll('\\','/')]?.mcpServers??{};
  const settings=[join(root,'settings.json'),join(project,'.claude','settings.json'),join(project,'.claude','settings.local.json')].map(readJsonc);
  const providerSettings:{env:Record<string,string>;apiKeyHelper?:string}={env:{}};let model:string|undefined;
  for(const item of settings){
    if(item.env&&typeof item.env==='object')for(const [key,value] of Object.entries(item.env))if(typeof value==='string')providerSettings.env[key]=value;
    if(typeof item.apiKeyHelper==='string')providerSettings.apiKeyHelper=item.apiKeyHelper;
    if(typeof item.model==='string')model=item.model;
  }
  return {globalPath,servers:{...user.mcpServers,...workspace.mcpServers,...local} as Record<string,any>,providerSettings,model};
}
export function registerQueue(runtime:'opencode'|'claude-code',connection:Connection,tools:string[],stateDir:string,home=homedir()) {
  if(runtime==='opencode') {
    const tokenFile=join(stateDir,'agent-token.txt');savePrivate(tokenFile,connection.agentToken);
    const path=opencodeConfigFile(home);
    const permission=Object.fromEntries([['*','deny'],...tools.map(tool=>[tool,'allow'])]);
    const queue={type:'remote',url:new URL('/mcp',connection.serverUrl).href,enabled:true,oauth:false,
      headers:{Authorization:`Bearer {file:${tokenFile.replaceAll('\\','/')}}`}};
    const reader={description:'승인된 문서 질문의 답변 초안',mode:'primary',steps:12,
      prompt:'Read the referenced documents and prepare a draft for human review. Do not write, execute commands, delegate, or publish.',permission};
    const backup=updateJsonc(path,[{path:['mcp','queue'],value:queue},{path:['agent','queue-reader'],value:reader}]);
    return {path,backup,overlay:{mcp:{queue},agent:{'queue-reader':reader}}};
  }
  const path=home===homedir()&&process.env.CLAUDE_CONFIG_DIR?join(process.env.CLAUDE_CONFIG_DIR,'.claude.json'):join(home,'.claude.json');
  const backup=updateJsonc(path,[{path:['mcpServers','queue'],value:{type:'http',url:new URL('/mcp',connection.serverUrl).href,
    headers:{Authorization:`Bearer ${connection.agentToken}`}}}]);
  return {path,backup};
}
export function executableCommand(path:string):string[] {
  const absolute=resolve(path);if(!existsSync(absolute)||!statSync(absolute).isFile())throw new Error('실행 파일을 찾을 수 없습니다. 설치 위치를 확인하세요.');
  if(/\.(mjs|cjs|js)$/i.test(absolute))return [process.execPath,absolute];
  if(/\.(cmd|bat|ps1)$/i.test(absolute)) {
    for(const file of [join(dirname(absolute),'node_modules','opencode-ai','bin','opencode.exe'),
      join(dirname(absolute),'node_modules','@anthropic-ai','claude-code','cli.js')])if(existsSync(file))return /\.js$/.test(file)?[process.execPath,file]:[file];
    throw new Error('네이티브 실행 파일 또는 CLI의 JS 파일을 선택하세요.');
  }
  return [absolute];
}
export function detectRuntimes(home=homedir()):Record<'opencode'|'claude-code',string[]|null> {
  const result:Record<'opencode'|'claude-code',string[]|null>={opencode:null,'claude-code':null};
  for(const [runtime,name] of [['opencode','opencode'],['claude-code','claude']] as const) {
    const paths=[...(process.env.PATH??'').split(delimiter).filter(Boolean),join(home,'.local','bin'),join(home,'.opencode','bin')];
    for(const folder of paths){for(const suffix of process.platform==='win32'?['.exe','.cmd','']:['']) {
      const file=join(folder,name+suffix);if(existsSync(file)){try{result[runtime]=executableCommand(file);}catch{}if(result[runtime])break;}
    }if(result[runtime])break;}
  }
  return result;
}
export function validProject(path:string):string {
  if(!isAbsolute(path)||!existsSync(path)||!statSync(path).isDirectory())throw new Error('사용 중인 프로젝트 폴더의 전체 경로를 입력하세요.');
  return resolve(path);
}
