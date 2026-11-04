import express from 'express';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import { authenticate, authSchema, type AuthEntry } from './auth.js';
import { AppError, createSchema, type Actor } from './types.js';
import { Store } from './store.js';
import { handleMcp } from './mcp.js';
import { IdentityStore } from './identity.js';
import { BrowserAuth, authSettings, type AuthSettings } from './oidc.js';
import { registerDownloads } from './downloads.js';

export function createApp(options: { database: string; auth?: AuthEntry[]; authentication?: AuthSettings }) {
  const settings=options.authentication??{...authSettings({AUTH_MODE:'legacy',QUEUE_SERVER_URL:'http://localhost'}),mode:'legacy' as const};
  const auth = settings.mode==='legacy'?authSchema.parse(options.auth??[]):[];
  const users:{id:string;name:string;email?:string|null}[] = [...new Map(auth.map(a => [a.id, { id: a.id, name: a.name }])).values()];
  const store = new Store(options.database, users);
  const identities=new IdentityStore(store.db);
  let browser:BrowserAuth;
  try{browser=new BrowserAuth(identities,settings);}catch(error){store.close();throw error;}
  const refreshUsers=()=>{const combined=new Map(users.filter(user=>auth.some(entry=>entry.id===user.id)).map(user=>[user.id,user]));
    for(const person of identities.list())combined.set(person.id,{id:person.id,name:person.name,email:person.email});
    users.splice(0,users.length,...combined.values());};
  identities.onUsersChange=refreshUsers;refreshUsers();
  const tokenActor=(token:string)=>settings.mode==='legacy'?authenticate(auth,token)??identities.token(token):browser.ready?identities.token(token):undefined;
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
  registerDownloads(app);
  app.use(express.static(resolve('public')));
  browser.routes(app);
  const actors = new WeakMap<express.Request, Actor>();
  const sessions=new WeakMap<express.Request,NonNullable<ReturnType<typeof browser.browser>>>();
  app.use((req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const session=!header&&browser.ready?browser.browser(req):undefined;
    const actor = header.startsWith('Bearer ') ? tokenActor(header.slice(7)) : session?.actor;
    if (!actor) return next(new AppError(401, 'Valid Bearer token required'));
    if(session){try{if(!['GET','HEAD','OPTIONS'].includes(req.method))browser.checkWrite(req,session);sessions.set(req,session);}catch(error){return next(error);}}
    actors.set(req, actor); next();
  });
  const actor = (req: express.Request) => actors.get(req)!;
  app.get('/api/me', (req, res) => res.json(actor(req)));
  app.get('/api/users', (_req, res) => res.json(users));
  app.get('/api/devices',(req,res)=>res.json(identities.devices(actor(req))));
  app.post('/api/devices',(req,res)=>{
    const session=sessions.get(req);if(!session)throw new AppError(403,'사내 웹 로그인이 필요합니다.');
    const input=z.object({label:z.string().trim().min(1).max(100)}).strict().parse(req.body);
    const issued=identities.issueDevice(session,input.label,settings.keyDays);
    res.status(201).json({version:2,serverUrl:browser.publicUrl.origin,userId:session.actor.id,name:session.actor.name,deviceId:issued.id,
      agentToken:issued.agentToken,workerToken:issued.workerToken,expiresAt:issued.expiresAt});
  });
  app.post('/api/devices/:id/revoke',(req,res)=>{identities.revoke(actor(req),req.params.id as string);res.json({ok:true});});
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
  const sockets = new Map<WebSocket, {actor:Actor;valid:()=>Actor|undefined}>();
  identities.onUsersChange=()=>{
    refreshUsers();for(const [ws,connection] of sockets){
      if(!connection.valid()){ws.close(1008,'Credential expired or revoked');continue;}
      if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'users_changed'}));
    }
  };
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
        const message = z.discriminatedUnion('type',[
          z.object({ type:z.literal('auth'), token:z.string().max(256) }),z.object({type:z.literal('session')})
        ]).parse(JSON.parse(data.toString()));
        const valid=message.type==='auth'?()=>tokenActor(message.token):()=>{
          if(!browser.ready||req.headers.origin!==browser.publicUrl.origin)return;
          return browser.browser(req as express.Request)?.actor;
        };
        const identity=valid();
        if (!identity) return ws.close(1008, 'Invalid credential');
        sockets.set(ws,{actor:identity,valid}); clearTimeout(timeout); ws.send(JSON.stringify({ type: 'ready' }));
      } catch { ws.close(1008, 'Invalid authentication message'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => { clearTimeout(timeout); sockets.delete(ws); });
  });
  store.onChange = task => {
    for (const [ws, connection] of sockets) {
      if(!connection.valid()){ws.close(1008,'Credential expired or revoked');continue;}
      if (ws.readyState === WebSocket.OPEN && [task.sender, task.recipient].includes(connection.actor.id))
        ws.send(JSON.stringify({ type: 'changed', id: task.id, state: task.state }));
    }
  };
  const heartbeat = setInterval(() => { for (const ws of wss.clients) {
    if(sockets.has(ws)&&!sockets.get(ws)!.valid()){ws.close(1008,'Credential expired or revoked');continue;}
    if ((ws as WebSocket & { alive?: boolean }).alive === false) { ws.terminate(); continue; }
    (ws as WebSocket & { alive?: boolean }).alive = false; ws.ping();
  } }, 30000);
  wss.on('connection', ws => ws.on('pong', () => { (ws as WebSocket & { alive?: boolean }).alive = true; }));
  heartbeat.unref();
  return { app, http, store, identities, browser, close: async () => {
    clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(done => wss.close(() => done()));
    await new Promise<void>((done, reject) => { http.close(error => error ? reject(error) : done()); http.closeIdleConnections(); });
    store.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const database = process.env.DATABASE_PATH ?? '.local/queue.sqlite';
  mkdirSync(dirname(database), { recursive: true });
  const authFile=process.env.AUTH_FILE??'.local/auth.json';
  if(!process.env.QUEUE_SERVER_URL){try{process.env.QUEUE_SERVER_URL=readFileSync(join(dirname(authFile),'server-address.txt'),'utf8').trim();}catch{}}
  const authentication=authSettings();
  if(authentication.mode==='development'&&process.env.QUEUE_BIND_ADDRESS&&!['127.0.0.1','::1','localhost'].includes(process.env.QUEUE_BIND_ADDRESS))
    throw new Error('Development login requires a loopback-only port binding.');
  const auth = authentication.mode==='legacy'?authSchema.parse(JSON.parse(readFileSync(authFile,'utf8'))):[];
  const instance = createApp({ database, auth, authentication });
  instance.http.listen(Number(process.env.PORT ?? 3000), authentication.mode==='development'&&process.env.QUEUE_IN_CONTAINER!=='1'?'127.0.0.1':'0.0.0.0', () => console.log('mcp-queue server listening'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void instance.close().then(() => process.exit(0)); });
}
