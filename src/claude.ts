import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Task } from './types.js';
import type { ClaudeConfig } from './config.js';
import { taskPrompt, type AgentAdapter } from './agent.js';

export function claudeArguments(config: ClaudeConfig, sessionId: string, proxyConfig: string): string[] {
  return [
    '--print', '--output-format', 'json', '--session-id', sessionId,
    '--permission-mode', 'dontAsk', '--tools', '',
    '--setting-sources', '', '--disable-slash-commands',
    '--settings', JSON.stringify({ disableAllHooks: true, permissions: { allow: config.claude.allowedTools } }),
    '--strict-mcp-config', '--mcp-config', proxyConfig,
    '--allowedTools', config.claude.allowedTools.join(','),
    '--max-turns', String(config.claude.maxTurns),
    ...(config.claude.model ? ['--model', config.claude.model] : [])
  ];
}

export class ClaudeCodeAdapter implements AgentAdapter {
  constructor(readonly config: ClaudeConfig) {
    if (!isAbsolute(config.directory)) throw new Error('directory must be an absolute local project path.');
    if (!isAbsolute(config.claude.mcpConfig)) throw new Error('claude.mcpConfig must be an absolute local file path.');
    if (/\.(cmd|bat|ps1)$/i.test(config.claude.command[0]))
      throw new Error('Use the native Claude executable, or [node, absolute/path/to/cli.js]; shell launchers are not supported.');
    if (statSync(config.claude.mcpConfig).size > 262144) throw new Error('Claude MCP configuration is too large.');
    const mcp = z.object({ mcpServers: z.record(z.string(), z.record(z.string(), z.unknown())) })
      .parse(JSON.parse(readFileSync(config.claude.mcpConfig, 'utf8')));
    for (const tool of config.claude.allowedTools) {
      const server = tool.slice(5).split('__')[0];
      if (!Object.hasOwn(mcp.mcpServers, server)) throw new Error(`Allowed tool references missing MCP server: ${server}`);
    }
  }
  async execute(task: Task, onSession: (session: string) => Promise<void>, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const sessionId = randomUUID();
    await onSession(`claude-code:${sessionId}`);
    signal.throwIfAborted();
    const temp = mkdtempSync(join(tmpdir(),'mcp-queue-claude-'));
    const proxyConfig = join(temp,'mcp.json');
    let output: string;
    try {
      const byServer = new Map<string,string[]>();
      for(const tool of this.config.claude.allowedTools){
        const [server,...parts]=tool.slice(5).split('__');
        byServer.set(server,[...(byServer.get(server)??[]),parts.join('__')]);
      }
      const proxyPath=fileURLToPath(new URL('./claude-mcp.js',import.meta.url));
      const mcpServers=Object.fromEntries([...byServer].map(([server,names])=>[server,{
        command:process.execPath,args:[proxyPath,this.config.claude.mcpConfig,server,JSON.stringify(names)]
      }]));
      writeFileSync(proxyConfig,JSON.stringify({mcpServers}),{mode:0o600});
      output = await this.run(claudeArguments(this.config, sessionId, proxyConfig), taskPrompt(task), signal);
    }finally{try{unlinkSync(proxyConfig);}finally{rmdirSync(temp);}}
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { throw new Error('Claude Code returned invalid JSON. Check CLI version and the saved session.'); }
    const result = z.object({
      type: z.literal('result'), subtype: z.string(), is_error: z.boolean(), result: z.string().optional(),
      session_id: z.string(), permission_denials: z.array(z.unknown()).optional()
    }).safeParse(parsed);
    if (!result.success) throw new Error('Claude Code returned an unexpected result format; inspect the saved session.');
    if (result.data.session_id !== sessionId) throw new Error('Claude Code returned a different session ID.');
    if (result.data.is_error || result.data.subtype !== 'success') throw new Error('Claude Code did not complete successfully; inspect the saved session and local authentication.');
    if (result.data.permission_denials?.length) throw new Error('Claude Code reported denied tool calls. Verify the document tool allowlist and inspect the saved session.');
    const text = result.data.result?.trim();
    if (!text || text.length > 64000) throw new Error('Claude Code returned an empty or oversized draft; inspect the saved session.');
    return text;
  }
  private run(args: string[], prompt: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const [command, ...prefix] = this.config.claude.command;
      const child = spawn(command, [...prefix, ...args], {
        cwd: this.config.directory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
      let output = ''; let bytes = 0; let failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 3000);
      };
      const abort = () => { failure = new Error('Claude Code execution was interrupted; inspect the saved session before retrying.'); terminate(); };
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) { failure = new Error('Claude Code output exceeded the local limit.'); terminate(); }
        else output += chunk;
      });
      // Consume stderr, but never forward potentially confidential CLI diagnostics to the shared server.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', error => { failure = new Error(`Cannot run Claude Code (${(error as NodeJS.ErrnoException).code ?? 'process error'}). Verify claude.command and local installation.`); });
      child.on('close', code => {
        clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Claude Code exited with code ${code}. Inspect the local session, CLI configuration and authentication.`));
        else resolve(output);
      });
      if (signal.aborted) abort();
      else child.stdin.end(prompt);
    });
  }
}
