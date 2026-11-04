import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { serverAddress } from './server-address.mjs';

const destination = resolve(process.env.QUEUE_SETUP_DIR ?? '.local');
if (existsSync(join(destination, 'auth.json'))) {
  console.error('Existing auth.json found. Setup will not overwrite credentials.'); process.exit(1);
}
const serverUrl = serverAddress().url;
const auth = [];
mkdirSync(destination, { recursive: true, mode: 0o700 });
for (const id of ['alice', 'bob']) {
  const tokens = Object.fromEntries(['human', 'agent', 'worker'].map(role => [role, randomBytes(32).toString('base64url')]));
  for (const [role, token] of Object.entries(tokens)) auth.push({ id, name: id === 'alice' ? '사용자 A' : '사용자 B', role,
    tokenHash: createHash('sha256').update(token).digest('hex') });
  const folder = join(destination, id); mkdirSync(folder, { recursive: true, mode: 0o700 });
  const save = (name, value) => writeFileSync(join(folder, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  save('human-token.txt', tokens.human + '\n');
  save('manager.json', { runtime: 'opencode', serverUrl, workerToken: tokens.worker, opencodeUrl: 'http://127.0.0.1:4096',
    directory: 'REPLACE_WITH_ABSOLUTE_OPENCODE_PROJECT_DIRECTORY', opencodeUsername: 'opencode',
    opencodePassword: '', agent: 'queue-reader', timeoutMs: 600000, reconcileMs: 60000 });
  save('opencode-mcp.json', { mcp: { queue: { type: 'remote', url: `${serverUrl}/mcp`, enabled: true,
    oauth: false, headers: { Authorization: `Bearer ${tokens.agent}` } } } });
  save('claude-mcp.json', { mcpServers: { queue: { type: 'http', url: `${serverUrl}/mcp`,
    headers: { Authorization: `Bearer ${tokens.agent}` } } } });
  save('manager.claude.json', { runtime: 'claude-code', serverUrl, workerToken: tokens.worker,
    directory: 'REPLACE_WITH_ABSOLUTE_CLAUDE_PROJECT_DIRECTORY',
    claude: { command: [process.platform === 'win32' ? 'claude.exe' : 'claude'],
      mcpConfig: 'REPLACE_WITH_ABSOLUTE_DOCUMENT_MCP_CONFIG_FILE',
      allowedTools: ['mcp__corpdocs__search_documents', 'mcp__corpdocs__get_document'], maxTurns: 12 },
    timeoutMs: 600000, reconcileMs: 60000 });
}
// Server receives hashes only. Readable by the unprivileged container user; raw tokens remain mode 0600.
writeFileSync(join(destination, 'auth.json'), JSON.stringify(auth, null, 2) + '\n', { mode: 0o644 });
console.log(`Created server auth hashes and separate alice/bob user bundles in ${destination}`);
console.log('Give each user only their own folder. Do not commit .local or copy both user bundles to either PC.');
