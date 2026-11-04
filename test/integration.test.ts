import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { tokenHash, type AuthEntry } from '../src/auth.js';
import { exercise, type Tokens } from './workflow.js';

test('two users: real MCP request, human approval, local manager, private draft, reviewed reply, reverse direction', async () => {
  const dir = mkdtempSync(join(tmpdir(),'queue-integration-'));
  const tokens = Object.fromEntries(['alice','bob'].map(id => [id, Object.fromEntries(['human','agent','worker'].map(role => [role,randomBytes(32).toString('hex')]))])) as Tokens;
  const auth = Object.entries(tokens).flatMap(([id, roles]) => Object.entries(roles).map(([role,token]) => ({id,name:id,role,tokenHash:tokenHash(token)}))) as AuthEntry[];
  const app = createApp({ database:join(dir,'queue.sqlite'), auth });
  await new Promise<void>(done => app.http.listen(0,'127.0.0.1',done));
  const address = app.http.address(); assert(address && typeof address !== 'string');
  try { const result = await exercise(`http://127.0.0.1:${address.port}`,tokens,join(dir,'outbox')); assert.equal(result.agentRuns,2); }
  finally { await app.close(); rmSync(dir,{recursive:true,force:true}); }
});
