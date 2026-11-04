import assert from 'node:assert/strict';

// Creates an empty, titled session and inspects API schemas. Never sends a model prompt.
const base = process.env.OPENCODE_CONTRACT_URL ?? 'http://127.0.0.1:4096';
const password = process.env.OPENCODE_CONTRACT_PASSWORD;
const headers = { 'Content-Type':'application/json', ...(password ? { Authorization:`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } : {}) };
const call = async (path, body) => {
  const response = await fetch(new URL(path,base),{ headers,method:body === undefined ? 'GET':'POST',
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000) });
  assert.equal(response.status,200,`${path}: unexpected status`); return response.json();
};
const health = await call('/global/health'); assert.equal(health.healthy,true);
const agents = await call('/agent'); assert(agents.some(agent => agent.name === 'queue-reader'),'Install the queue-reader profile first');
const session = await call('/session',{title:'MCP Queue API contract check (no prompt)'}); assert.equal(typeof session.id,'string');
const spec = await call('/doc'); assert(spec.paths['/session/{sessionID}/message']?.post,'Missing expected message endpoint');
console.log({version:health.version,queueReaderProfileFound:true,sessionCreated:true,messageEndpointFound:true,modelPromptsSent:0});
