import { readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { OpenCodeAdapter } from './opencode.js';
import { ClaudeCodeAdapter } from './claude.js';
import { managerSchema, type ManagerConfig } from './config.js';
import type { AgentAdapter } from './agent.js';
import type { Task } from './types.js';

type Pending = { id: string; runId: string; kind: 'draft' | 'fail'; text: string };
export class Manager {
  private connected=false;
  status(){return {connected:this.connected,working:this.busy};}
  private stopped = false;
  private busy = false;
  private requested = false;
  private ws?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private pingTimer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private readonly adapter: AgentAdapter;
  private readonly pendingDir: string;
  private idleWaiters: (() => void)[] = [];
  constructor(readonly config: ManagerConfig, stateDir: string) {
    this.adapter = config.runtime === 'claude-code' ? new ClaudeCodeAdapter(config) : new OpenCodeAdapter(config);
    const identity = createHash('sha256').update(config.serverUrl + config.workerToken).digest('hex').slice(0, 20);
    this.pendingDir = join(stateDir, identity);
    mkdirSync(this.pendingDir, { recursive: true, mode: 0o700 });
  }
  private async api(path: string, body?: unknown) {
    const response = await fetch(new URL(path, this.config.serverUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.config.workerToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw Object.assign(new Error(`Queue HTTP ${response.status}`), { status: response.status });
    return response.json() as Promise<unknown>;
  }
  private save(pending: Pending) {
    const target = join(this.pendingDir, `${pending.id}.json`);
    writeFileSync(`${target}.tmp`, JSON.stringify(pending), { mode: 0o600 });
    chmodSync(`${target}.tmp`, 0o600); renameSync(`${target}.tmp`, target);
  }
  private async flush(): Promise<boolean> {
    for (const file of readdirSync(this.pendingDir).filter(f => /^[0-9a-f-]{36}\.json$/.test(f))) {
      const path = join(this.pendingDir, file);
      const pending = z.object({ id: z.string().uuid(), runId: z.string().uuid(), kind: z.enum(['draft', 'fail']), text: z.string() })
        .parse(JSON.parse(readFileSync(path, 'utf8')));
      try { await this.api(`/api/worker/${pending.id}/update`, { runId: pending.runId, kind: pending.kind, text: pending.text }); unlinkSync(path); }
      catch (error) {
        if (error instanceof Error && 'status' in error && error.status === 409) {
          // Server may have accepted a draft before the connection dropped. Reconcile without replaying the agent.
          const current = await this.api(`/api/requests/${pending.id}`) as Task;
          const accepted = current.runId === pending.runId &&
            ((pending.kind === 'draft' && current.state === 'draft' && current.draft === pending.text) ||
             (pending.kind === 'fail' && current.state === 'failed' && current.error === pending.text));
          if (accepted) unlinkSync(path);
          else {
            renameSync(path, `${path}.conflict`);
            console.error(`Saved result for ${pending.id} needs manual reconciliation (${file}.conflict).`);
          }
        } else { console.error('Result delivery deferred; the local outbox will retry without rerunning the agent.'); return false; }
      }
    }
    return true;
  }
  async start() {
    const me = z.object({ id: z.string(), role: z.literal('worker') }).parse(await this.api('/api/me'));
    console.log(`Manager connected for ${me.id} (${this.config.runtime}). Only human-approved requests will run.`);
    this.connect();
    this.interval = setInterval(() => { void this.wake(); }, this.config.reconcileMs);
    await this.wake();
  }
  private connect() {
    if (this.stopped) return;
    const url = new URL('/events', this.config.serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = this.ws = new WebSocket(url);
    const alive = () => {
      clearTimeout(this.pingTimer);
      this.pingTimer = setTimeout(() => ws.terminate(), 70000);
    };
    ws.on('open', () => { alive(); ws.send(JSON.stringify({ type: 'auth', token: this.config.workerToken })); });
    ws.on('ping', alive);
    ws.on('message', data => {
      try { const message = JSON.parse(data.toString()); if (message.type==='ready')this.connected=true; if (['ready', 'changed'].includes(message.type)) void this.wake(); }
      catch { /* Ignore malformed notifications; the database is authoritative. */ }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      this.connected=false;
      clearTimeout(this.pingTimer);
      if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), 2000 + Math.random() * 1000);
    });
  }
  async wake() {
    if (this.stopped) return;
    this.requested = true;
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.requested && !this.stopped) {
        this.requested = false;
        if (!await this.flush()) break;
        const task = await this.api('/api/worker/claim', {}) as Task | null;
        if (!task) continue;
        this.controller = new AbortController();
        const timeout = setTimeout(() => this.controller?.abort(), this.config.timeoutMs);
        let pending: Pending;
        try {
          console.log(`Running request ${task.id}`);
          const text = await this.adapter.execute(task, async session => {
            await this.api(`/api/worker/${task.id}/update`, { runId: task.runId, kind: 'session', text: session });
          }, this.controller.signal);
          pending = { id: task.id, runId: task.runId!, kind: 'draft', text };
        } catch (error) {
          pending = { id: task.id, runId: task.runId!, kind: 'fail', text:
            `Execution did not complete. ${error instanceof Error ? error.message : 'Unknown error'}. Check the saved ${this.config.runtime} session before retrying; a timeout does not prove execution stopped.` };
        } finally { clearTimeout(timeout); this.controller = undefined; }
        // Persist before delivery. A network retry must never rerun the LLM.
        this.save(pending);
        if (!await this.flush()) break;
        console.log(`Request ${task.id}: ${pending.kind === 'draft' ? 'draft ready for human review' : 'failed; human review required'}`);
        this.requested = true;
      }
    } catch (error) { console.error(error instanceof Error ? error.message : 'Manager reconciliation failed'); }
    finally { this.busy = false; for (const done of this.idleWaiters.splice(0)) done(); }
  }
  async stop() {
    this.stopped = true; clearInterval(this.interval); clearTimeout(this.reconnect); clearTimeout(this.pingTimer);
    this.ws?.terminate(); this.controller?.abort();
    if (this.busy) await new Promise<void>(done => this.idleWaiters.push(done));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  if (!configPath) { console.error('Usage: npm run manager -- path/to/manager.json'); process.exit(1); }
  const config = managerSchema.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  const manager = new Manager(config, resolve('.local/outbox'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void manager.stop().then(() => process.exit(0)); });
  await manager.start();
}
