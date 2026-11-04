import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exercise } from '../dist/test/workflow.js';
const tokens = {};
for (const id of ['alice','bob']) {
  const root = join('.local',id);
  tokens[id] = {
    human:readFileSync(join(root,'human-token.txt'),'utf8').trim(),
    worker:JSON.parse(readFileSync(join(root,'manager.json'),'utf8')).workerToken,
    agent:JSON.parse(readFileSync(join(root,'opencode-mcp.json'),'utf8')).mcp.queue.headers.Authorization.slice(7)
  };
}
const state = mkdtempSync(join(tmpdir(),'queue-compose-'));
console.log(await exercise(process.env.QUEUE_SERVER_URL ?? 'http://localhost:3000',tokens,state,{mixed:process.env.QUEUE_SMOKE_MIXED==='1'}));
// Keep any undelivered outbox intact on failure; the script never removes server data or volumes.
