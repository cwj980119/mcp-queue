import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AppError, type Actor, type NewRequest, type State, type Task } from './types.js';

export class Store {
  readonly db: DatabaseSync;
  onChange: (task: Task) => void = () => {};
  constructor(path: string, readonly users: { id: string; name: string }[]) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, documentRef TEXT NOT NULL, documentVersion TEXT NOT NULL,
        state TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        runId TEXT, sessionId TEXT, idempotencyKey TEXT NOT NULL, fingerprint TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(sender, idempotencyKey)
      );
      CREATE INDEX IF NOT EXISTS inbox ON requests(recipient, state, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_user ON requests(recipient) WHERE state='running';
      CREATE TABLE IF NOT EXISTS history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, state TEXT NOT NULL, time TEXT NOT NULL
      );`);
    if(!(this.db.prepare('PRAGMA table_info(requests)').all() as any[]).some(column=>column.name==='runDeviceId'))
      this.db.exec('ALTER TABLE requests ADD COLUMN runDeviceId TEXT');
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private raw(id: string): Task {
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if (!row) throw new AppError(404, 'Request not found');
    return row as unknown as Task;
  }
  private audit(task: Task, actor: Actor, action: string) {
    this.db.prepare('INSERT INTO history(requestId,actor,action,state,time) VALUES(?,?,?,?,?)')
      .run(task.id, `${actor.id}:${actor.role}`, action, task.state, new Date().toISOString());
  }
  private view(task: Task, actor: Actor): Task {
    // Explicit projection: never return internal keys/fingerprints or a recipient's unpublished answer.
    const { id, sender, recipient, title, body, documentRef, documentVersion, state, draft, result,
      error, runId, sessionId, createdAt, updatedAt } = task;
    const own = recipient === actor.id;
    return { id, sender, recipient, title, body, documentRef, documentVersion, state,
      draft: own ? draft : '', result, error: own ? error : '',
      runId: own ? runId : null, sessionId: own ? sessionId : null, createdAt, updatedAt };
  }
  get(actor: Actor, id: string): Task {
    const task = this.raw(id);
    if (task.sender !== actor.id && task.recipient !== actor.id) throw new AppError(404, 'Request not found');
    return this.view(task, actor);
  }
  history(actor: Actor, id: string) {
    this.get(actor, id);
    return this.db.prepare('SELECT seq,actor,action,state,time FROM history WHERE requestId=? ORDER BY seq').all(id);
  }
  list(actor: Actor, box: 'inbox' | 'sent' = 'inbox'): Task[] {
    const column = box === 'inbox' ? 'recipient' : 'sender';
    return (this.db.prepare(`SELECT * FROM requests WHERE ${column}=? ORDER BY createdAt DESC, id DESC LIMIT 200`)
      .all(actor.id) as unknown as Task[]).map(row => this.view(row, actor));
  }
  create(actor: Actor, input: NewRequest): Task {
    if (actor.role === 'worker') throw new AppError(403, 'Worker cannot create requests');
    if (!this.users.some(u => u.id === input.recipient) || input.recipient === actor.id)
      throw new AppError(400, 'Choose another registered user');
    const fingerprint = JSON.stringify([input.recipient, input.title, input.body, input.documentRef, input.documentVersion]);
    let created = false;
    const task = this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM requests WHERE sender=? AND idempotencyKey=?')
        .get(actor.id, input.idempotencyKey) as unknown as (Task & { fingerprint: string }) | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AppError(409, 'Idempotency key already used for different content');
        return existing;
      }
      const now = new Date().toISOString(); const id = randomUUID();
      this.db.prepare(`INSERT INTO requests(id,sender,recipient,title,body,documentRef,documentVersion,state,idempotencyKey,fingerprint,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(id, actor.id, input.recipient, input.title, input.body,
          input.documentRef, input.documentVersion, input.idempotencyKey, fingerprint, now, now);
      const inserted = this.raw(id); this.audit(inserted, actor, 'create'); created = true; return inserted;
    });
    if (created) this.onChange(task);
    return this.view(task, actor);
  }
  act(actor: Actor, id: string, action: string, text = ''): Task {
    if (actor.role !== 'human') throw new AppError(403, 'Human credential required');
    const task = this.transaction(() => {
      const current = this.raw(id);
      if (current.sender !== actor.id && current.recipient !== actor.id) throw new AppError(404, 'Request not found');
      const recipient = current.recipient === actor.id;
      let next: State;
      if (action === 'cancel' && current.sender === actor.id && ['pending', 'approved'].includes(current.state)) next = 'cancelled';
      else if (recipient && action === 'approve' && ['pending', 'failed'].includes(current.state)) next = 'approved';
      else if (recipient && action === 'reject' && ['pending', 'approved'].includes(current.state)) next = 'rejected';
      else if (recipient && action === 'publish' && current.state === 'draft' && text.trim()) next = 'replied';
      else if (recipient && action === 'interrupt' && current.state === 'running') next = 'failed';
      else throw new AppError(409, 'Action is not allowed in this state');
      this.db.prepare(`UPDATE requests SET state=?, result=?, error=?, runId=NULL, updatedAt=? WHERE id=?`)
        .run(next, next === 'replied' ? text.trim() : current.result,
          action === 'interrupt' ? 'Marked interrupted by user. Check the local agent session before retrying.' : '',
          new Date().toISOString(), id);
      const updated = this.raw(id); this.audit(updated, actor, action); return updated;
    });
    this.onChange(task); return this.view(task, actor);
  }
  claim(actor: Actor): Task | null {
    if (actor.role !== 'worker') throw new AppError(403, 'Worker credential required');
    // Adapted from TinyTask TaskService.signupForTask (MIT, Eric Oliver), see THIRD_PARTY_NOTICES.md.
    // Keep the select and update in one write transaction; notify only after commit.
    const task = this.transaction(() => {
      if (this.db.prepare("SELECT id FROM requests WHERE recipient=? AND state='running'").get(actor.id)) return null;
      const first = this.db.prepare("SELECT id FROM requests WHERE recipient=? AND state='approved' ORDER BY createdAt,id LIMIT 1")
        .get(actor.id) as { id: string } | undefined;
      if (!first) return null;
      this.db.prepare("UPDATE requests SET state='running', runId=?, runDeviceId=?, sessionId=NULL, draft='', error='', updatedAt=? WHERE id=? AND state='approved'")
        .run(randomUUID(),actor.deviceId??null,new Date().toISOString(),first.id);
      const updated = this.raw(first.id); this.audit(updated, actor, 'claim'); return updated;
    });
    if (task) this.onChange(task);
    return task ? this.view(task, actor) : null;
  }
  complete(actor: Actor, id: string, runId: string, kind: 'session' | 'draft' | 'fail', text: string): Task {
    if (actor.role !== 'worker') throw new AppError(403, 'Worker credential required');
    const task = this.transaction(() => {
      const current = this.raw(id);
      if (current.recipient !== actor.id) throw new AppError(404, 'Request not found');
      if (current.state !== 'running' || current.runId !== runId) throw new AppError(409, 'Run is no longer active');
      const binding=this.db.prepare('SELECT runDeviceId FROM requests WHERE id=?').get(id) as {runDeviceId:string|null};
      if(binding.runDeviceId&&binding.runDeviceId!==actor.deviceId)throw new AppError(403,'This run belongs to another PC');
      const next = kind === 'session' ? 'running' : kind === 'draft' ? 'draft' : 'failed';
      this.db.prepare('UPDATE requests SET state=?,sessionId=?,draft=?,error=?,updatedAt=? WHERE id=?').run(next,
        kind === 'session' ? text : current.sessionId, kind === 'draft' ? text : current.draft,
        kind === 'fail' ? text : '', new Date().toISOString(), id);
      const updated = this.raw(id); this.audit(updated, actor, kind); return updated;
    });
    this.onChange(task); return this.view(task, actor);
  }
}
