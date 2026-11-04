const $ = id => document.getElementById(id);
const labels = { pending:'승인 대기', approved:'실행 대기', running:'내 PC에서 처리 중', draft:'답변 검토 대기', replied:'답변 전송 완료', rejected:'거절됨', failed:'확인 필요', cancelled:'취소됨' };
let token = '', csrf = '', authMode = '', me, people = new Map(), box = 'inbox', selected, socket, timer, fallback, generation = 0, createKey;
const person = id => people.get(id)?.name || id;
const notice = message => { $('notice').textContent = message; };
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    credentials:'same-origin', headers: { ...(token?{Authorization:`Bearer ${token}`}:{'X-CSRF-Token':csrf}), 'Content-Type':'application/json' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(response.status===401?'로그인이 만료되었거나 연결 키가 유효하지 않습니다. 새로고침 후 다시 로그인하세요.':data.error || `HTTP ${response.status}`); return data;
}
function connect(epoch) {
  if (epoch !== generation || !me) return;
  const ws = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
  ws.onopen = () => ws.send(JSON.stringify(token?{type:'auth',token}:{type:'session'}));
  ws.onmessage = event => { const message = JSON.parse(event.data); if (['ready','changed','users_changed'].includes(message.type)) {
    $('connection').textContent = '실시간 연결됨'; refresh().catch(error => notice(error.message));
  } };
  ws.onclose = event => { if (epoch === generation && me) {
    if(event.code===1008){$('connection').textContent='로그인 확인 필요';clearInterval(fallback);notice('로그인 또는 연결 키가 만료되었습니다. 페이지를 새로고침해 다시 로그인하세요.');return;}
    $('connection').textContent = '재연결 중'; timer = setTimeout(() => connect(epoch), 2500);
  } };
  ws.onerror = () => {};
}
async function refresh() {
  const epoch = generation; const currentBox = box;
  const [tasks,users] = await Promise.all([api(`/api/requests?box=${box}`),api('/api/users')]);
  if (epoch !== generation || box !== currentBox) return;
  people=new Map(users.map(user=>[user.id,user]));
  const recipient=$('recipient').value;$('recipient').replaceChildren();
  for(const user of users.filter(user=>user.id!==me.id)){
    const option=element('option',`${user.name}${user.email?` (${user.email})`:''}`);option.value=user.id;$('recipient').append(option);
  }
  if(users.some(user=>user.id===recipient))$('recipient').value=recipient;
  $('requests').replaceChildren();
  if (!tasks.length) $('requests').append(element('p','아직 요청이 없습니다.','hint'));
  for (const task of tasks) {
    const row = element('button',undefined,'request');
    row.append(element('span',labels[task.state],`state ${task.state}`),element('strong',task.title),element('small',`${person(task.sender)} → ${person(task.recipient)}`));
    row.onclick = () => show(task.id).catch(error => notice(error.message)); $('requests').append(row);
  }
  // Preserve an answer currently being edited when an unrelated notification arrives.
  if (selected && !$('draft-answer')) await show(selected);
}
async function perform(id, action, text = '') {
  await api(`/api/requests/${id}/action`, { action, text });
  selected = id; await show(id); await refresh(); notice('저장했습니다.');
}
async function show(id) {
  selected = id; const epoch = generation;
  const [task, history] = await Promise.all([api(`/api/requests/${id}`),api(`/api/requests/${id}/history`)]);
  if (epoch !== generation || selected !== id) return;
  const pane = $('detail'); pane.replaceChildren();
  pane.append(element('span',labels[task.state],`state ${task.state}`),element('h2',task.title),element('p',`${person(task.sender)} → ${person(task.recipient)} · ${new Date(task.createdAt).toLocaleString()}`,'metadata'),element('pre',task.body));
  if (task.documentRef) pane.append(element('p',`문서: ${task.documentRef}${task.documentVersion ? ` · 버전 ${task.documentVersion}` : ''}`,'metadata'));
  if (task.sessionId) pane.append(element('p',`로컬 에이전트 세션: ${task.sessionId}`,'metadata'));
  if (task.error) pane.append(element('pre',task.error));
  if (task.result) pane.append(element('h2','전달한 답변'),element('pre',task.result));
  const actions = element('div',undefined,'actions');
  const button = (text, action, value, confirmation) => {
    const node = element('button',text); node.onclick = async () => {
      if (confirmation && !confirm(confirmation)) return;
      node.disabled = true;
      try { await perform(id, action, typeof value === 'function' ? value() : value); }
      catch (error) { notice(error.message); node.disabled = false; }
    }; actions.append(node);
  };
  if (task.recipient === me.id) {
    if (task.state === 'pending') button('내 에이전트 실행 승인','approve');
    if (task.state === 'failed') button('세션 확인 후 재승인','approve','', '기존 에이전트 세션이 종료되었는지 확인했습니까? 이전 실행의 효과가 남아 있을 수 있습니다.');
    if (['pending','approved'].includes(task.state)) button('거절','reject');
    if (task.state === 'approved') pane.append(element('p','PC 관리자가 연결되어 있으면 곧 시작합니다.','hint'));
    if (task.state === 'running') button('중단된 실행으로 표시','interrupt','', '이 버튼은 에이전트를 중지하지 않습니다. 먼저 로컬 세션 상태를 확인하세요. 실행 상태만 실패로 바꿉니다.');
    if (task.state === 'draft') {
      pane.append(element('h2','답변 초안'));
      const answer = element('textarea'); answer.id = 'draft-answer'; answer.rows = 14; answer.maxLength = 64000; answer.value = task.draft; pane.append(answer);
      pane.append(element('p','문서 접근 권한과 공유 범위를 확인한 뒤 전송하세요. 수정 내용은 전송 시 저장됩니다.','hint'));
      button('검토한 답변 최종 전송','publish',() => answer.value);
    }
  }
  if (task.sender === me.id && ['pending','approved'].includes(task.state)) button('요청 취소','cancel');
  pane.append(actions);
  const details = element('details'); details.append(element('summary','처리 이력'));
  const list = element('ol',undefined,'history'); for (const entry of history) list.append(element('li',`${new Date(entry.time).toLocaleString()} · ${entry.actor} · ${entry.action}`));
  details.append(list); pane.append(details);
}
async function enterWorkspace() {
  me=await api('/api/me');if(me.role!=='human')throw new Error('사람 계정으로 로그인하세요.');
  $('token').value='';$('login').hidden=true;$('workspace').hidden=false;$('identity').textContent=me.name;$('pc-panel').hidden=!!token;
  notice('');const epoch=++generation;connect(epoch);clearInterval(fallback);
  fallback=setInterval(()=>refresh().catch(error=>notice(error.message)),60000);await refresh();if(!token)await devices();
}
async function devices() {
  const list=await api('/api/devices');$('devices').replaceChildren();
  for(const device of list){
    const row=element('div',undefined,'device');
    row.append(element('strong',device.label),element('p',`${device.revokedAt?'폐기됨':`만료: ${new Date(device.expiresAt).toLocaleDateString()}`} · 마지막 연결: ${device.lastSeen?new Date(device.lastSeen).toLocaleString():'아직 없음'}`,'hint'));
    if(device.oidcDeviceName)row.append(element('p',`사내 인증 PC: ${device.oidcDeviceName}`,'hint'));
    if(!device.revokedAt){const button=element('button','이 PC 연결 폐기');button.onclick=async()=>{
      if(!confirm(`${device.label}의 연결을 폐기할까요? 이 PC의 에이전트가 더 이상 서버에 접근할 수 없습니다.`))return;
      try{await api(`/api/devices/${device.id}/revoke`,{});await devices();notice('PC 연결을 폐기했습니다. 실행 중인 로컬 에이전트 프로세스는 해당 PC에서 직접 중지하세요.');}catch(error){notice(error.message);}
    };row.append(button);}$('devices').append(row);
  }
}
$('issue-device').onsubmit=async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  try{
    const bundle=await api('/api/devices',{label:$('device-label').value});
    const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)+'\n'],{type:'application/json'}));
    const link=element('a');link.href=url;link.download=`${bundle.deviceId}.queue.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    await devices();notice('연결 파일을 다운로드했습니다. 내 PC에서 사용자-시작.cmd를 실행하고 이 파일을 불러오세요.');
  }catch(error){notice(error.message);}finally{button.disabled=false;}
};
$('development-login').onsubmit=async event=>{
  event.preventDefault();try{await api('/auth/development',{name:$('dev-name').value,email:$('dev-email').value});const session=await api('/auth/session');csrf=session.csrf;await enterWorkspace();}catch(error){notice(error.message);}
};
$('login-form').onsubmit = async event => {
  event.preventDefault(); token = $('token').value.trim();
  try {
    if(authMode!=='legacy')throw new Error('사내 계정으로 로그인하세요.');await enterWorkspace();
  } catch (error) { token = ''; notice(error.message); }
};
$('connection-login').onsubmit=async event=>{
  event.preventDefault();
  try{
    const file=$('login-file').files[0];if(!file||file.size>12000)throw new Error('관리자에게 받은 연결 파일을 선택하세요.');
    const value=JSON.parse(await file.text());
    if(value.version!==1||typeof value.humanToken!=='string'||value.humanToken.length<20)throw new Error('연결 파일을 확인하세요.');
    if(new URL(value.serverUrl).origin!==location.origin)throw new Error(`이 파일은 ${new URL(value.serverUrl).origin} 서버에서 사용하세요.`);
    $('token').value=value.humanToken;$('login-form').requestSubmit();$('connection-login').reset();
  }catch(error){notice(error.message);}
};
async function initialize(){
  const fragment=location.hash;if(fragment)history.replaceState(null,'',location.pathname+location.search);
  try{
    const config=await api('/auth/config');authMode=config.mode;
    if(authMode==='development'){$('mode-banner').hidden=false;$('mode-banner').textContent='로컬 개발 모드 · 사내 인증을 사용하지 않습니다.';}
    if(!config.ready){$('login-description').textContent='서버의 로그인 환경변수 설정이 필요합니다. 관리자에게 문의하세요.';notice(`필요한 설정: ${config.missing.join(', ')}`);return;}
    $('legacy-login').hidden=authMode!=='legacy';$('development-login').hidden=authMode!=='development';$('sso-login').hidden=authMode!=='oidc';
    $('login-description').textContent=authMode==='oidc'?'사내 계정으로 로그인하면 내 요청함이 자동으로 만들어집니다.':authMode==='development'?'개발용 계정으로 흐름을 확인하세요.':'기존 연결 파일로 로그인하세요.';
    if(authMode==='legacy'){
      if(fragment.startsWith('#login=')){$('token').value=decodeURIComponent(fragment.slice(7));$('login-form').requestSubmit();}return;
    }
    const response=await fetch('/auth/session');
    if(response.ok){const session=await response.json();csrf=session.csrf;if(session.deviceName)$('device-label').value=session.deviceName;await enterWorkspace();return;}
    const parameters=new URLSearchParams(location.search);
    if(parameters.has('auth_error'))notice('사내 로그인에 실패했습니다. 다시 시도하거나 관리자에게 OIDC 설정 확인을 요청하세요.');
    else if(authMode==='oidc'&&config.autoLogin&&!parameters.has('signed_out'))location.replace('/auth/login');
  }catch(error){notice(error.message);}
}
void initialize();
for (const name of ['inbox','sent']) $(name).onclick = () => {
  box = name; selected = undefined; $('detail').replaceChildren(element('p','요청을 선택하세요.','hint'));
  $('box-title').textContent = name === 'inbox' ? '받은 요청' : '보낸 요청';
  $('inbox').classList.toggle('selected',name === 'inbox'); $('sent').classList.toggle('selected',name === 'sent'); refresh().catch(error => notice(error.message));
};
$('refresh').onclick = () => refresh().catch(error => notice(error.message));
$('logout').onclick = async () => {
  try{if(!token)await api('/auth/logout',{});generation++;token='';csrf='';me=undefined;clearTimeout(timer);clearInterval(fallback);socket?.close();location.assign('/?signed_out=1');}catch(error){notice(error.message);}
};
$('create-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const data = Object.fromEntries(['recipient','title','body','documentRef','documentVersion'].map(id => [id,$(id).value]));
  // Keep the key for a retry only if the content is unchanged.
  const fingerprint = JSON.stringify(data); if (!createKey || createKey.fingerprint !== fingerprint) createKey = { fingerprint, key:crypto.randomUUID() };
  try { const task = await api('/api/requests',{ ...data,idempotencyKey:createKey.key }); createKey = undefined; $('create-form').reset();
    $('sent').click(); await show(task.id); await refresh(); notice('요청을 보냈습니다. 받는 사람의 승인을 기다립니다.');
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
};
