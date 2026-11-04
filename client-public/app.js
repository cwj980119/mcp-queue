const $=id=>document.getElementById(id);
const key=document.querySelector('meta[name="client-key"]').content;
let state, manualChange=false, waiting=false;
function notice(message){$('notice').textContent=message;}
async function api(path,body){const response=await fetch(`/api/${path}`,{method:body===undefined?'GET':'POST',headers:{'X-Client-Key':key,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw new Error(value.error||'연결 중 오류가 발생했습니다.');return value;}
function render(value){state=value;
  $('opencode-installed').textContent=value.installed.opencode?'설치됨':'설치 경로 확인 필요';
  $('claude-installed').textContent=value.installed['claude-code']?'설치됨':'설치 경로 확인 필요';
  $('identity').hidden=!value.identity;if(value.identity)$('identity').textContent=`✓ ${value.identity.name} · ${value.identity.serverUrl}`;
  $('import-form').hidden=!!value.identity;
  $('agent-card').hidden=!value.identity||(value.configured&&!manualChange);
  $('ready-card').hidden=!value.configured;
  $('ready-title').textContent=value.running?'내 에이전트가 연결되었습니다.':'설정이 저장되어 있습니다.';
  $('runtime-status').textContent=value.running?(value.status.connected?(value.status.working?'● 승인된 업무를 처리 중입니다.':'● 서버와 연결됨 · 승인된 업무 대기 중'):'서버에 연결 중입니다.'):'시작 버튼을 누르면 승인된 업무를 처리합니다.';
  $('start').hidden=value.running;$('stop').hidden=!value.running;
  $('change').disabled=value.running;
  if(value.configured&&!manualChange)$('docs-card').hidden=true;
  if(value.choice&&!$('directory').value){$('directory').value=value.choice.directory;document.querySelector(`input[name=runtime][value="${value.choice.runtime}"]`).checked=true;}
}
async function action(button,fn){if(waiting)return;waiting=true;button.disabled=true;notice('처리 중입니다. 잠시 기다려주세요.');try{await fn();}catch(error){notice(error.message);}finally{waiting=false;button.disabled=false;}}
$('import-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
  const file=$('connection-file').files[0];if(!file)throw new Error('연결 파일을 선택하세요.');
  if(file.size>12000)throw new Error('관리자에게 받은 연결 파일을 선택하세요.');
  const value=await api('import',{text:await file.text(),...($('server-url').value?{serverUrl:$('server-url').value}:{})});
  render(value);notice(value.message);if(!value.installed.opencode&&value.installed['claude-code'])document.querySelector('input[value="claude-code"]').checked=true;
});};
$('inspect-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
  const value=await api('inspect',{runtime:document.querySelector('input[name=runtime]:checked').value,directory:$('directory').value,
    ...($('executable').value?{executable:$('executable').value}:{})});render(value);
  $('docs-card').hidden=false;$('connect-form').hidden=true;$('doc-server').replaceChildren();
  for(const server of value.project.servers){const option=document.createElement('option');option.value=server;option.textContent=server;$('doc-server').append(option);}
  $('no-servers').hidden=!!value.project.servers.length;$('tools-form').hidden=!value.project.servers.length;notice(value.message);
});};
for(const input of document.querySelectorAll('input[name=runtime], #directory, #executable'))input.addEventListener('input',()=>{$('docs-card').hidden=true;$('connect-form').hidden=true;});
$('doc-server').onchange=()=>{$('connect-form').hidden=true;$('tools').replaceChildren();};
$('tools-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
  const value=await api('tools',{server:$('doc-server').value});$('tools').replaceChildren();
  for(const tool of value.tools){const label=document.createElement('label');label.className='tool';
    const input=document.createElement('input');input.type='checkbox';input.value=tool.name;input.checked=tool.recommended;
    const text=document.createElement('span');const title=document.createElement('strong');title.textContent=tool.description.slice(0,140);text.append(title);
    const name=document.createElement('small');name.textContent=tool.name+(tool.recommended?' · 읽기 후보':'');text.append(name);label.append(input,text);$('tools').append(label);}
  $('connect-form').hidden=false;notice(value.tools.length?'사용할 검색·읽기 기능을 선택하세요.':'사용 가능한 기능을 찾지 못했습니다.');
});};
$('connect-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
  const tools=[...$('tools').querySelectorAll('input:checked')].map(input=>input.value);
  if(!tools.length)throw new Error('검색·읽기 기능을 하나 이상 선택하세요.');
  const value=await api('connect',{server:$('doc-server').value,tools});manualChange=false;render(value);notice(value.message);
});};
for(const actionName of ['start','stop'])$(actionName).onclick=event=>action(event.target,async()=>{const value=await api(actionName,{});render(value);notice(value.message);});
$('change').onclick=()=>{manualChange=true;render(state);$('agent-card').scrollIntoView({behavior:'smooth'});};
$('open-inbox').onclick=async()=>{const tab=window.open('about:blank','_blank');try{const value=await api('login',{});if(tab){tab.opener=null;tab.location=value.url;}else location.href=value.url;}catch(error){tab?.close();notice(error.message);}};
api('state').then(render).catch(error=>notice(error.message));
setInterval(()=>{if(!waiting)api('state').then(render).catch(()=>notice('PC 연결 프로그램과 연결이 끊겼습니다. 시작 파일을 다시 실행하세요.'));},2500);
