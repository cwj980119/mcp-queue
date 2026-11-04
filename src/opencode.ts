import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { Task } from './types.js';
import type { OpenCodeConfig } from './config.js';
import { taskPrompt, type AgentAdapter } from './agent.js';
export { managerSchema, type ManagerConfig } from './config.js';

export class OpenCodeAdapter implements AgentAdapter {
  constructor(readonly config: OpenCodeConfig) {
    if (!isAbsolute(config.directory)) throw new Error('directory must be the absolute path of your existing OpenCode project.');
    const url = new URL(config.opencodeUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error('opencodeUrl must be loopback. Run the manager on the same PC as OpenCode.');
  }
  private async call(path: string, body: unknown | undefined, signal: AbortSignal) {
    const url = new URL(path, this.config.opencodeUrl);
    url.searchParams.set('directory', this.config.directory);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.opencodePassword) headers.Authorization = `Basic ${Buffer.from(`${this.config.opencodeUsername}:${this.config.opencodePassword}`).toString('base64')}`;
    let response: Response;
    try { response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal }); }
    catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`Cannot reach local OpenCode at ${this.config.opencodeUrl}. Start OpenCode in your configured project first. The MCP Queue web UI is on the queue server URL, not port 4096.`);
    }
    // Do not include response bodies: they may contain document data or local credentials.
    if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  }
  async execute(task: Task, onSession: (session: string) => Promise<void>, signal: AbortSignal): Promise<string> {
    const health = z.object({ healthy: z.literal(true) }).parse(await this.call('/global/health', undefined, signal));
    if (!health.healthy) throw new Error('OpenCode is unhealthy');
    const agents = z.array(z.object({ name: z.string() }).passthrough()).parse(await this.call('/agent', undefined, signal));
    if (!agents.some(agent => agent.name === this.config.agent))
      throw new Error(`Configured agent '${this.config.agent}' is missing. Install the restricted queue-reader profile first.`);
    const session = z.object({ id: z.string().min(1) }).parse(await this.call('/session', { title: `Queue: ${task.title}` }, signal));
    // Persist the session before starting work, so a human can inspect an interrupted attempt.
    await onSession(session.id);
    const instruction = taskPrompt(task);
    const response = z.object({
      info: z.object({ error: z.unknown().optional() }).passthrough(),
      parts: z.array(z.object({ type: z.string(), text: z.string().optional(), ignored: z.boolean().optional(), synthetic: z.boolean().optional() }).passthrough())
    }).parse(await this.call(`/session/${encodeURIComponent(session.id)}/message`, {
      ...(this.config.agent ? { agent: this.config.agent } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      parts: [{ type: 'text', text: instruction }]
    }, signal));
    if (response.info.error) throw new Error('OpenCode reported an agent error; inspect the saved session');
    const answer = response.parts.filter(p => p.type === 'text' && !p.ignored && !p.synthetic).map(p => p.text ?? '').join('\n').trim();
    if (!answer) throw new Error('OpenCode returned no draft text');
    if (answer.length > 64000) throw new Error('Draft exceeds 64000 characters; inspect the saved session');
    return answer;
  }
}
