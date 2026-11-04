# Third-party notices and source review

Source review date: 2026-11-04. This is a small integration built on existing libraries, not a fork of a full orchestration platform.

## Adapted source: TinyTask / TKO

- Repository: https://github.com/ericroliver/tinytask
- Reviewed revision: `cd3eda372a47235006ea96228b213e6b6c63eb63`
- Source: `src/services/task-service.ts`, `TaskService.signupForTask`, lines 647–696 at that revision.
- Adaptation: `src/store.ts`, `Store.claim`: select one eligible task and update it in a write transaction; emit a notification after commit. Adapted to node:sqlite, recipient identities, human approval, and attempt IDs. Priority, subtasks and queue transfers were omitted.
- The upstream package.json says ISC, but the actual LICENSE at the reviewed revision is **MIT**. The source license below is preserved rather than relying on the package metadata.

MIT License

Copyright (c) 2025 Eric Oliver

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Architecture references (no source copied)

| Project | Reviewed revision and source | Used as a reference for |
| --- | --- | --- |
| [OpenAgentEmail](https://github.com/openagentemail/openagentemail) | `812af3ff59167ab63d5d848f60c5cdb338534824`, `docs/first-task-handoff.md` | Separate requester/recipient identities, structured tasks and explicit handoff. Its guide does not assume automatic terminal wakeup. No mail backend is needed here. |
| [Paperclip](https://github.com/paperclipai/paperclip) | `f211d44c00fbc31d22e7ff687e22dfa05643da2a`, `packages/adapters/opencode-local/src/server/execute.ts` | OpenCode adapter boundary, session tracking and task input. This prototype calls the local HTTP API instead of copying its CLI/configuration handling. |

Agent Mail Rust is not incorporated. Its reviewed license includes an additional usage restriction, so its source was excluded. A2A, Redis, Temporal and full Paperclip/OAE deployments are not dependencies of this two-user prototype.

## Runtime dependencies

These packages are consumed as dependencies through npm, not reimplemented. Their own notices accompany the packages in node_modules and Docker images. Exact transitive versions are recorded in package-lock.json.

| Component | Upstream | License |
| --- | --- | --- |
| MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk | MIT |
| Express | https://github.com/expressjs/express | MIT |
| ws | https://github.com/websockets/ws | MIT |
| Zod | https://github.com/colinhacks/zod | MIT |
| jsonc-parser | https://github.com/microsoft/node-jsonc-parser | MIT |
| SQLite via Node.js | https://nodejs.org/api/sqlite.html | Node.js MIT; SQLite public domain |

The web UI uses plain HTML, CSS and JavaScript without a frontend framework. OpenCode or Claude Code is installed and licensed separately on each user's PC. Claude Code is invoked through its documented CLI; no Claude Code implementation is copied or bundled. The local document tool filter uses the official MCP SDK.
