import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { Manager } from '../src/manager.js';
import { managerSchema } from '../src/opencode.js';
import type { Task } from '../src/types.js';

export type Tokens = Record<'alice' | 'bob', Record<'human' | 'agent' | 'worker', string>>;
export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeout = 10000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(done => setTimeout(done, 40)); }
  throw new Error('Timed out waiting for expected state');
}
export async function exercise(url: string, tokens: Tokens, stateDir: string) {
  let promptCalls = 0;
  const directory = resolve('test/mock-project');
  const prompts: unknown[] = [];
  const mock = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (path.pathname === '/global/health') return res.end(JSON.stringify({ healthy: true, version: 'mock-v1' }));
    if (path.pathname === '/agent') return res.end(JSON.stringify([{ name: 'queue-reader' }]));
    if (path.pathname === '/session') return res.end(JSON.stringify({ id: `ses_${randomUUID()}` }));
    if (/^\/session\/[^/]+\/message$/.test(path.pathname)) {
      let body = ''; for await (const chunk of req) body += chunk;
      prompts.push(JSON.parse(body)); promptCalls++;
      assert.equal(path.searchParams.get('directory'), directory);
      assert.equal((JSON.parse(body) as { agent: string }).agent, 'queue-reader');
      return res.end(JSON.stringify({ info: { role: 'assistant' }, parts: [{ type: 'text', text: '초안: 문서 DOC-42 v3을 확인한 결과입니다. (테스트용 OpenCode 응답)' }] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(done => mock.listen(0, '127.0.0.1', done));
  const address = mock.address(); assert(address && typeof address !== 'string');
  const managers = (['alice', 'bob'] as const).map(id => new Manager(managerSchema.parse({
    serverUrl: url, workerToken: tokens[id].worker, opencodeUrl: `http://127.0.0.1:${address.port}`,
    directory, timeoutMs: 10000, reconcileMs: 1000
  }), stateDir));
  const api = async (id: 'alice' | 'bob', role: 'human' | 'agent' | 'worker', path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${tokens[id][role]}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, status, `${path} unexpected status`); return response.json() as Promise<any>;
  };
  const client = new Client({ name:'integration', version:'1.0' });
  const notifications: { id?: string; type: string }[] = [];
  const wsUrl = new URL('/events', url); wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(wsUrl);
  ws.on('open', () => ws.send(JSON.stringify({ type:'auth', token:tokens.bob.human })));
  ws.on('message', data => notifications.push(JSON.parse(data.toString())));
  try {
    await waitFor(async () => notifications.find(n => n.type === 'ready'));
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization:`Bearer ${tokens.alice.agent}` } } }));
    const tools = await client.listTools(); assert.equal(tools.tools.length, 4);
    const key = randomUUID();
    const created = await client.callTool({ name:'create_request', arguments: {
      recipient:'bob', title:'[SMOKE] 사내 문서 검토', body:'DOC-42를 확인해 요약해주세요.', documentRef:'DOC-42', documentVersion:'v3', idempotencyKey:key
    } });
    assert(!created.isError); const blocks = created.content as { type:string; text:string }[];
    const task = JSON.parse(blocks[0].text) as Task;
    const duplicate = await api('alice','agent','/api/requests',{ recipient:'bob',title:task.title,body:task.body,documentRef:'DOC-42',documentVersion:'v3',idempotencyKey:key },201);
    assert.equal(duplicate.id, task.id);
    await api('alice','human',`/api/requests/${task.id}/action`,{action:'approve'},409);
    await api('bob','agent',`/api/requests/${task.id}/action`,{action:'approve'},403);
    assert.equal(promptCalls,0);
    // Approve before the recipient manager starts: catch-up must work without receiving the original event.
    await api('bob','human',`/api/requests/${task.id}/action`,{action:'approve'});
    await Promise.all(managers.map(manager => manager.start()));
    const draft = await waitFor(async () => { const t = await api('bob','human',`/api/requests/${task.id}`); return t.state === 'draft' && t; });
    assert.match(draft.draft,/DOC-42/); assert(draft.sessionId);
    assert.equal((await api('alice','human',`/api/requests/${task.id}`)).draft,'');
    await api('bob','worker',`/api/requests/${task.id}/action`,{action:'publish',text:draft.draft},403);
    await api('bob','human',`/api/requests/${task.id}/action`,{action:'publish',text:'검토 완료: DOC-42 v3에 근거한 답변입니다.'});
    const result = await api('alice','agent',`/api/requests/${task.id}`); assert.equal(result.state,'replied'); assert.match(result.result,/검토 완료/);
    assert(notifications.some(n => n.id === task.id && n.type === 'changed'));
    // Reverse direction proves both PCs can act as recipient without launching the sender on a reply.
    const reverse = await api('bob','agent','/api/requests',{recipient:'alice',title:'[SMOKE] 역방향 질문',body:'문서를 확인해주세요.',documentRef:'DOC-42',idempotencyKey:randomUUID()},201);
    await api('alice','human',`/api/requests/${reverse.id}/action`,{action:'approve'});
    const reverseDraft = await waitFor(async () => { const t = await api('alice','human',`/api/requests/${reverse.id}`); return t.state === 'draft' && t; });
    await api('alice','human',`/api/requests/${reverse.id}/action`,{action:'publish',text:reverseDraft.draft});
    assert.equal((await api('bob','human',`/api/requests/${reverse.id}`)).state,'replied');
    assert.equal(promptCalls,2); assert.equal(prompts.length,2);
    return { requests:2, agentRuns:promptCalls, mcpTools:tools.tools.length, transport:'real MCP + REST + WebSocket; mock OpenCode, no GLM calls' };
  } finally {
    ws.terminate(); await client.close(); await Promise.all(managers.map(manager => manager.stop()));
    await new Promise<void>(done => { mock.close(() => done()); mock.closeAllConnections(); });
  }
}
