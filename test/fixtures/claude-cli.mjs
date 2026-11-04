import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
const argv=process.argv.slice(2);
const value=name=>argv[argv.indexOf(name)+1];
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
if(argv.includes('--fixture-log'))appendFileSync(value('--fixture-log'),JSON.stringify({argv,prompt})+'\n');
assert(argv.includes('--print'));assert.equal(value('--output-format'),'json');
assert.equal(value('--permission-mode'),'dontAsk');assert.equal(value('--tools'),'');
assert.equal(value('--setting-sources'),'');assert(argv.includes('--strict-mcp-config'));
assert(argv.includes('--disable-slash-commands'));assert.equal(JSON.parse(value('--settings')).disableAllHooks,true);
assert(!argv.some(arg=>arg.includes('skip-permissions')));
const mode=argv.includes('--fixture-mode')?value('--fixture-mode'):'success';
if(mode==='hang'){
  process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
}else if(mode==='exit'){
  console.error('PRIVATE_DIAGNOSTIC_MUST_NOT_LEAVE_PC');process.exit(7);
}else if(mode==='bad-json')console.log('not JSON');
else console.log(JSON.stringify({type:'result',subtype:mode==='error'?'error_during_execution':'success',is_error:mode==='error',
  session_id:mode==='wrong-session'?'unexpected':value('--session-id'),
  result:mode==='empty'?'':'초안: 문서 DOC-42 v3을 확인했습니다. (테스트용 Claude Code 응답)',
  permission_denials:mode==='denied'?[{tool_name:'mcp__corpdocs__get_document'}]:[]}));
