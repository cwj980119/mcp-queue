import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Actor } from './types.js';
import { createSchema } from './types.js';
import type { Store } from './store.js';

export async function handleMcp(req: Request, res: Response, actor: Actor, store: Store) {
  const server = new McpServer({ name: 'mcp-queue', version: '0.1.0' });
  const wrap = (fn: () => unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(fn()) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Operation failed' }] }; }
  };
  server.registerTool('list_users', { description: 'List users who can receive requests. No agent is started by this tool.' },
    async () => wrap(() => store.users));
  server.registerTool('create_request', {
    description: 'Send a request to another user only when instructed by your user. Include document references, not confidential document contents. Use a stable unique idempotencyKey for retries. The recipient must approve execution.',
    inputSchema: createSchema.shape
  }, async input => wrap(() => store.create(actor, createSchema.parse(input))));
  server.registerTool('list_requests', {
    description: 'Read latest 200 received or sent requests. Unpublished recipient drafts are hidden from the sender.',
    inputSchema: { box: z.enum(['inbox', 'sent']).default('inbox') }
  }, async ({ box }) => wrap(() => store.list(actor, box)));
  server.registerTool('get_request', {
    description: 'Read one request and its status history. Approval and publication are available only to the human in the web UI.',
    inputSchema: { id: z.string().uuid() }
  }, async ({ id }) => wrap(() => ({ request: store.get(actor, id), history: store.history(actor, id) })));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
