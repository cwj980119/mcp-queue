const $ = id => document.getElementById(id);
const labels = { pending:'승인 대기', approved:'실행 대기', running:'내 PC에서 처리 중', draft:'답변 검토 대기', replied:'답변 전송 완료', rejected:'거절됨', failed:'확인 필요', cancelled:'취소됨' };
let token = '', me, box = 'inbox', selected, socket, timer, fallback, generation = 0, createKey;
const notice = message => { $('notice').textContent = message; };
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
}
function connect(epoch) {
  if (epoch !== generation || !token) return;
  const ws = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
  ws.onopen = () => ws.send(JSON.stringify({ type:'auth', token }));
  ws.onmessage = event => { const message = JSON.parse(event.data); if (['ready','changed'].includes(message.type)) {
    $('connection').textContent = '실시간 연결됨'; refresh().catch(error => notice(error.message));
  } };
  ws.onclose = () => { if (epoch === generation && token) { $('connection').textContent = '재연결 중'; timer = setTimeout(() => connect(epoch), 2500); } };
  ws.onerror = () => {};
}
async function refresh() {
  const epoch = generation; const currentBox = box;
  const tasks = await api(`/api/requests?box=${box}`);
  if (epoch !== generation || box !== currentBox) return;
  $('requests').replaceChildren();
  if (!tasks.length) $('requests').append(element('p','아직 요청이 없습니다.','hint'));
  for (const task of tasks) {
    const row = element('button',undefined,'request');
    row.append(element('span',labels[task.state],`state ${task.state}`),element('strong',task.title),element('small',`${task.sender} → ${task.recipient}`));
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
  pane.append(element('span',labels[task.state],`state ${task.state}`),element('h2',task.title),element('p',`${task.sender} → ${task.recipient} · ${new Date(task.createdAt).toLocaleString()}`,'metadata'),element('pre',task.body));
  if (task.documentRef) pane.append(element('p',`문서: ${task.documentRef}${task.documentVersion ? ` · 버전 ${task.documentVersion}` : ''}`,'metadata'));
  if (task.sessionId) pane.append(element('p',`로컬 OpenCode 세션: ${task.sessionId}`,'metadata'));
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
    if (task.state === 'failed') button('세션 확인 후 재승인','approve','', '기존 OpenCode 세션이 종료되었는지 확인했습니까? 이전 실행의 효과가 남아 있을 수 있습니다.');
    if (['pending','approved'].includes(task.state)) button('거절','reject');
    if (task.state === 'approved') pane.append(element('p','PC 관리자가 연결되어 있으면 곧 시작합니다.','hint'));
    if (task.state === 'running') button('중단된 실행으로 표시','interrupt','', '이 버튼은 OpenCode를 중지하지 않습니다. 먼저 로컬 세션 상태를 확인하세요. 실행 상태만 실패로 바꿉니다.');
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
$('login-form').onsubmit = async event => {
  event.preventDefault(); token = $('token').value.trim();
  try {
    me = await api('/api/me'); if (me.role !== 'human') throw new Error('웹 화면에는 사람용 토큰을 사용하세요.');
    const users = await api('/api/users'); $('recipient').replaceChildren();
    for (const user of users.filter(user => user.id !== me.id)) { const option = element('option',`${user.name} (${user.id})`); option.value = user.id; $('recipient').append(option); }
    $('token').value = ''; $('login').hidden = true; $('workspace').hidden = false; $('identity').textContent = me.name;
    notice(''); const epoch = ++generation; connect(epoch); fallback = setInterval(() => refresh().catch(error => notice(error.message)),60000); await refresh();
  } catch (error) { token = ''; notice(error.message); }
};
for (const name of ['inbox','sent']) $(name).onclick = () => {
  box = name; selected = undefined; $('detail').replaceChildren(element('p','요청을 선택하세요.','hint'));
  $('box-title').textContent = name === 'inbox' ? '받은 요청' : '보낸 요청';
  $('inbox').classList.toggle('selected',name === 'inbox'); $('sent').classList.toggle('selected',name === 'sent'); refresh().catch(error => notice(error.message));
};
$('refresh').onclick = () => refresh().catch(error => notice(error.message));
$('logout').onclick = () => { generation++; token = ''; me = undefined; selected = undefined; clearTimeout(timer); clearInterval(fallback); socket?.close();
  $('workspace').hidden = true; $('login').hidden = false; $('identity').textContent = ''; $('requests').replaceChildren(); $('detail').replaceChildren(); notice(''); };
$('create-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const data = Object.fromEntries(['recipient','title','body','documentRef','documentVersion'].map(id => [id,$(id).value]));
  // Keep the key for a retry only if the content is unchanged.
  const fingerprint = JSON.stringify(data); if (!createKey || createKey.fingerprint !== fingerprint) createKey = { fingerprint, key:crypto.randomUUID() };
  try { const task = await api('/api/requests',{ ...data,idempotencyKey:createKey.key }); createKey = undefined; $('create-form').reset();
    $('sent').click(); await show(task.id); await refresh(); notice('요청을 보냈습니다. 받는 사람의 승인을 기다립니다.');
  } catch (error) { notice(error.message); } finally { button.disabled = false; }
};
