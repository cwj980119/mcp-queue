import express from 'express';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import { authenticate, authSchema, type AuthEntry } from './auth.js';
import { AppError, createSchema, type Actor } from './types.js';
import { Store } from './store.js';
import { handleMcp } from './mcp.js';

export function createApp(options: { database: string; auth: AuthEntry[] }) {
  const auth = authSchema.parse(options.auth);
  const users = [...new Map(auth.map(a => [a.id, { id: a.id, name: a.name }])).values()];
  const store = new Store(options.database, users);
  const app = express(); app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.static(resolve('public')));
  const actors = new WeakMap<express.Request, Actor>();
  app.use((req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const actor = header.startsWith('Bearer ') ? authenticate(auth, header.slice(7)) : undefined;
    if (!actor) return next(new AppError(401, 'Valid Bearer token required'));
    actors.set(req, actor); next();
  });
  const actor = (req: express.Request) => actors.get(req)!;
  app.get('/api/me', (req, res) => res.json(actor(req)));
  app.get('/api/users', (_req, res) => res.json(users));
  app.get('/api/requests', (req, res) => res.json(store.list(actor(req), z.enum(['inbox', 'sent']).default('inbox').parse(req.query.box))));
  app.post('/api/requests', (req, res) => res.status(201).json(store.create(actor(req), createSchema.parse(req.body))));
  app.get('/api/requests/:id', (req, res) => res.json(store.get(actor(req), req.params.id as string)));
  app.get('/api/requests/:id/history', (req, res) => res.json(store.history(actor(req), req.params.id as string)));
  app.post('/api/requests/:id/action', (req, res) => {
    const input = z.object({ action: z.enum(['approve', 'reject', 'publish', 'cancel', 'interrupt']), text: z.string().max(64000).default('') }).strict().parse(req.body);
    res.json(store.act(actor(req), req.params.id as string, input.action, input.text));
  });
  app.post('/api/worker/claim', (req, res) => res.json(store.claim(actor(req))));
  app.post('/api/worker/:id/update', (req, res) => {
    const input = z.object({ runId: z.string().uuid(), kind: z.enum(['session', 'draft', 'fail']), text: z.string().trim().min(1).max(64000) }).strict().parse(req.body);
    res.json(store.complete(actor(req), req.params.id as string, input.runId, input.kind, input.text));
  });
  app.post('/mcp', async (req, res, next) => {
    if (actor(req).role !== 'agent') return next(new AppError(403, 'Agent credential required'));
    try { await handleMcp(req, res, actor(req), store); } catch (error) { next(error); }
  });
  app.all('/mcp', (_req, res) => res.status(405).setHeader('Allow', 'POST').end());
  app.use((_req, _res, next) => next(new AppError(404, 'Not found')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    const code = error instanceof AppError ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 500;
    res.status(code).json({ error: code === 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Invalid request' });
    if (code === 500) console.error('Request failed:', error instanceof Error ? error.message : 'unknown');
  });
  const http = createServer(app);
  const wss = new WebSocketServer({ server: http, path: '/events', maxPayload: 4096 });
  const sockets = new Map<WebSocket, Actor>();
  wss.on('connection', (ws, req) => {
    // Browser clients must originate from this host; workers omit Origin. Tokens never enter URLs.
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return ws.close(1008, 'Origin rejected'); }
      catch { return ws.close(1008, 'Origin rejected'); }
    }
    const timeout = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    ws.on('message', data => {
      if (sockets.has(ws)) return;
      try {
        const message = z.object({ type: z.literal('auth'), token: z.string().max(256) }).parse(JSON.parse(data.toString()));
        const identity = authenticate(auth, message.token);
        if (!identity) return ws.close(1008, 'Invalid credential');
        sockets.set(ws, identity); clearTimeout(timeout); ws.send(JSON.stringify({ type: 'ready' }));
      } catch { ws.close(1008, 'Invalid authentication message'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => { clearTimeout(timeout); sockets.delete(ws); });
  });
  store.onChange = task => {
    for (const [ws, identity] of sockets) {
      if (ws.readyState === WebSocket.OPEN && [task.sender, task.recipient].includes(identity.id))
        ws.send(JSON.stringify({ type: 'changed', id: task.id, state: task.state }));
    }
  };
  const heartbeat = setInterval(() => { for (const ws of wss.clients) {
    if ((ws as WebSocket & { alive?: boolean }).alive === false) { ws.terminate(); continue; }
    (ws as WebSocket & { alive?: boolean }).alive = false; ws.ping();
  } }, 30000);
  wss.on('connection', ws => ws.on('pong', () => { (ws as WebSocket & { alive?: boolean }).alive = true; }));
  heartbeat.unref();
  return { app, http, store, close: async () => {
    clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(done => wss.close(() => done()));
    await new Promise<void>((done, reject) => { http.close(error => error ? reject(error) : done()); http.closeIdleConnections(); });
    store.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const database = process.env.DATABASE_PATH ?? '.local/queue.sqlite';
  mkdirSync(dirname(database), { recursive: true });
  const auth = authSchema.parse(JSON.parse(readFileSync(process.env.AUTH_FILE ?? '.local/auth.json', 'utf8')));
  const instance = createApp({ database, auth });
  instance.http.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => console.log('mcp-queue server listening'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void instance.close().then(() => process.exit(0)); });
}
