import { z } from 'zod';

const common = {
  serverUrl: z.string().url(), workerToken: z.string().min(20), directory: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(3600000).default(600000),
  reconcileMs: z.number().int().min(1000).default(60000)
};
const opencode = z.object({
  ...common, runtime: z.literal('opencode'),
  opencodeUrl: z.string().url().default('http://127.0.0.1:4096'),
  opencodeUsername: z.string().default('opencode'), opencodePassword: z.string().default(''),
  agent: z.string().min(1).default('queue-reader'),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional()
}).strict();
const claude = z.object({
  ...common, runtime: z.literal('claude-code'),
  claude: z.object({
    // Locally configured argv only; request content never determines the executable or flags.
    command: z.array(z.string().min(1)).min(1).max(8).default([process.platform === 'win32' ? 'claude.exe' : 'claude']),
    mcpConfig: z.string().min(1),
    allowedTools: z.array(z.string().regex(/^mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/)).min(1).max(30),
    model: z.string().min(1).optional(),
    providerSettings: z.object({env:z.record(z.string(),z.string()).default({}),apiKeyHelper:z.string().optional()}).strict().optional(),
    maxTurns: z.number().int().min(1).max(50).default(12)
  }).strict()
}).strict();
// Existing manager.json files remain valid and continue to select OpenCode.
export const managerSchema = z.preprocess(value => value && typeof value === 'object' && !Array.isArray(value)
  ? { runtime: 'opencode', ...value } : value, z.discriminatedUnion('runtime', [opencode, claude]));
export type ManagerConfig = z.infer<typeof managerSchema>;
export type OpenCodeConfig = Extract<ManagerConfig, { runtime: 'opencode' }>;
export type ClaudeConfig = Extract<ManagerConfig, { runtime: 'claude-code' }>;
