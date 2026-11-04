> 기존 정적 토큰 설치용 수동 안내입니다. 새 설치는 [간편 시작](easy-start.md)의 사내 로그인·PC 연결 화면을 사용하세요.

# Claude Code 사용자 연결

**일반 사용자는 [간편 시작](easy-start.md)을 권장합니다.** 아래는 수동 설정 안내입니다. 새 연결 화면은 기존 문서 MCP와 모델 제공자 설정을 찾아 파일을 자동 생성하므로 JSON을 직접 수정할 필요가 없습니다.

OpenCode 사용자와 Claude Code 사용자는 같은 Queue 서버를 사용합니다. 각 PC의 관리자가 런타임을 선택하므로 서버는 Claude Code를 설치할 필요가 없습니다. Claude Code 사용자 PC에는 **4096 포트가 필요 없습니다**. 브라우저 요청함은 중앙 Queue 서버 주소(로컬 시험은 `http://localhost:3000`)입니다.

## PC에 필요한 것

- Node.js 22.16 이상, npm, 이 저장소의 PC 관리자.
- 설치된 Claude Code CLI 및 본인 계정 로그인 또는 회사가 승인한 API 환경변수 설정.
- 본인이 접근 가능한 사내 문서 MCP 설정. 현재 문서 연결은 HTTP/SSE의 Bearer 헤더/환경변수 또는 stdio를 지원합니다.

Claude Code는 [공식 `-p` 비대화형 CLI](https://code.claude.com/docs/en/headless)를 사용합니다. SDK나 별도 상주 Claude 서버를 추가로 설치하지 않습니다. 실제 CLI 2.1.318의 `--help`에서 사용 플래그 존재를 확인했으며, 모델 프롬프트를 보내는 실제 추론은 이 환경에서 수행하지 않았습니다.

Windows는 네이티브 `claude.exe`를 권장합니다. `Get-Command claude`로 설치 위치를 확인하세요. npm 설치의 `.cmd`/`.bat`는 shell 없이 실행하지 못하므로, 그 경우 `command`를 `["C:/Program Files/nodejs/node.exe", "설치된/@anthropic-ai/claude-code/cli.js의/절대경로"]`로 지정하거나 네이티브 설치를 사용합니다. WSL 설치라면 관리자도 같은 WSL에서 실행합니다. CLI와 관리자 사이에 Windows/WSL 경로를 섞지 않습니다.

## 1. 본인 설정 받기

관리자로부터 받은 `.local/bob`을 예로 설명합니다. 새 setup은 두 런타임 설정을 모두 생성합니다. 이전 묶음에 Claude 파일이 없다면 서버 setup을 재실행하지 말고 다음 명령을 실행합니다.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run config:claude -- .local/bob
```

기존 사용자 토큰으로 `claude-mcp.json`, `manager.claude.json`만 추가합니다. 기존 파일을 덮어쓰거나 서버 인증 파일을 변경하지 않습니다. 사용자마다 자신의 묶음만 사용합니다.

## 2. 평소 사용하는 Claude Code에 Queue MCP 추가

`claude-mcp.json`의 `mcpServers.queue`를 프로젝트 `.mcp.json`에 병합합니다. 기존 사내 문서 MCP 항목은 유지합니다. 기존 `.mcp.json`을 전체 덮어쓰지 마세요. 생성 파일은 다음 [공식 HTTP MCP 설정](https://code.claude.com/docs/en/mcp) 형식입니다.

```json
{
  "mcpServers": {
    "queue": {
      "type": "http",
      "url": "https://queue.company.example/mcp",
      "headers": { "Authorization": "Bearer YOUR_OWN_AGENT_TOKEN" }
    }
  }
}
```

생성된 실제 파일에는 본인의 agent 토큰이 들어 있습니다. `.mcp.json`을 공유하는 저장소에는 토큰을 커밋하지 말고 `"Bearer ${QUEUE_AGENT_TOKEN}"`처럼 Claude Code의 환경변수 확장을 사용할 수 있습니다. 프로젝트 MCP 승인은 평소 Claude Code의 `/mcp` 화면에서 진행합니다. human/worker 토큰을 에이전트에 넘기지 않습니다.

이후 평소 대화에서 “queue MCP로 alice에게 DOC-42 검토를 요청해줘”라고 말할 수 있습니다. 이 단계는 요청 생성·조회용입니다. 수신 작업 자동 실행은 아래 PC 관리자가 담당합니다.

## 3. 수신 작업용 문서 MCP 파일 지정

수신 업무에는 **문서 MCP만** 담은 별도 로컬 JSON 파일을 사용합니다. 기존 사내 문서 MCP의 설정 항목을 복사해 사용할 수 있으며 문서 원문을 복사하는 것이 아닙니다. `examples/claude-docs-mcp.json`을 본인 `.local` 아래로 복사하고 실제 서비스 주소·인증 방식으로 수정합니다.

```json
{
  "mcpServers": {
    "corpdocs": {
      "type": "http",
      "url": "https://docs.company.example/mcp",
      "headers": { "Authorization": "Bearer ${CORPDOCS_TOKEN}" }
    }
  }
}
```

stdio 서비스라면 같은 자리에서 `command`, `args`, `env`를 사용합니다. shell 스크립트 대신 실행 파일 또는 `[node + JS 경로]` 형태를 사용하세요. 상대 경로는 피하고 실행 파일/스크립트 절대 경로를 권장합니다.

MCP 설정의 `${NAME}`과 `${NAME:-default}`는 관리자 프로세스 환경에서 확장됩니다. OAuth 로그인이 저장된 Claude MCP 자격증명 저장소를 읽는 기능은 이 필터에 아직 없습니다. 문서 서비스가 OAuth만 지원한다면 회사가 지원하는 Bearer/갱신 방식 또는 OAuth 어댑터 연동이 필요합니다. OpenCode에서 쓰던 설정 형식은 Claude의 `mcpServers` 형식으로 변환해야 합니다.

## 4. 실행 도구 선택

`.local/bob/manager.claude.json`을 수정합니다.

```json
{
  "runtime": "claude-code",
  "serverUrl": "https://queue.company.example",
  "workerToken": "KEEP_THE_DELIVERED_WORKER_TOKEN",
  "directory": "C:/work/my-project",
  "claude": {
    "command": ["claude.exe"],
    "mcpConfig": "C:/private/bob/document-mcp.json",
    "allowedTools": [
      "mcp__corpdocs__search_documents",
      "mcp__corpdocs__get_document"
    ],
    "maxTurns": 12
  },
  "timeoutMs": 600000,
  "reconcileMs": 60000
}
```

- `directory`: 자신의 프로젝트 절대 경로. 서버 요청으로 바뀌지 않습니다.
- `command`: 본인 PC에 설치된 CLI. Windows는 설치에 따라 exe 절대 경로를 지정할 수 있습니다. Linux/macOS에서는 `["claude"]`입니다.
- `mcpConfig`: 위의 문서 MCP JSON 절대 경로.
- `allowedTools`: 실제 검색·읽기 도구의 **전체 이름**. `mcp__서버이름__도구이름` 형식이며 wildcard는 허용하지 않습니다.
- `model`: 필요할 때 `claude` 객체에 실제 모델 ID 문자열을 추가합니다. 사내 GLM을 쓰려면 Claude Code가 그 API를 지원하도록 이미 설정되어 있어야 합니다. 이 프로젝트가 API 호환성을 변환하지 않습니다.

기존의 포괄적인 권한·프로젝트 hook이 수신 작업에 섞이지 않도록, 이 실행은 user/project/local settings를 읽지 않고 명시한 문서 MCP만 사용합니다. **기존 settings.json에만 있던 API 환경변수나 apiKeyHelper는 자동으로 가져오지 않습니다.** 필요한 회사 모델/API 설정은 관리자를 시작하는 셸의 환경변수에 적용하세요. CLI에 이미 저장된 로그인은 CLI가 지원하는 방식으로 사용하며, 회사 관리 정책은 계속 적용될 수 있습니다. 기존 CLAUDE.md 등의 문맥 및 CLI 내부 동작까지 격리하는 OS 샌드박스는 아닙니다.

## 5. 관리자 실행

```powershell
# 필요한 회사 모델/API·문서 MCP 환경변수를 이 셸에 설정한 뒤:
npm.cmd run manager -- .local/bob/manager.claude.json
```

OpenCode를 실행하거나 4096을 열 필요가 없습니다. 서버 웹에서 본인 `human-token.txt`로 로그인해 요청을 승인하면 로컬 CLI가 새 세션에서 실행됩니다. 완료 답변은 초안으로 저장되며 사람이 검토하고 최종 전송합니다. 웹에 `claude-code:<UUID>`로 세션을 표시하며, 로컬에서 `claude --resume <UUID>`로 확인할 수 있습니다.

같은 사용자 계정에 OpenCode 관리자와 Claude 관리자를 동시에 실행하지 마세요. 사용자당 실행 슬롯은 하나지만 어떤 관리자가 다음 요청을 인수할지는 먼저 도착한 쪽에 따라 달라집니다. 사용할 런타임 하나를 선택해 켭니다.

## 도구 제한과 실패

수신 실행은 `--tools ""`로 내장 파일/셸 도구를 끄고 `dontAsk`를 사용합니다. `--allowedTools`만으로 MCP 도구 목록이 제한되지는 않으므로, 별도 로컬 stdio 필터가 허용한 도구만 노출하고 다른 도구의 직접 호출도 거절합니다. 원래 사내 MCP는 공식 SDK 클라이언트로 연결하며 문서 내용이 중앙 서버를 거쳐 모델로 전달되지 않습니다. 초안·최종 답변은 Queue 서버에 저장됩니다.

필터는 도구 **이름**을 검사합니다. 선택한 도구가 실제 읽기 전용인지 판단하지 않으므로 쓰기 가능한 범용 도구를 allowlist에 넣지 마세요. 문서 서비스/로컬 stdio 서버는 사용자가 신뢰한 설정을 사용합니다. 권한 무시 플래그는 사용하지 않으며 도구 거부·인증 실패·CLI 오류는 확인이 필요한 실패 상태로 남깁니다.

취소 시 CLI에 종료 신호를 보내지만 하위 MCP 프로세스와 이미 수행된 효과까지 모두 중단했다고 보장하지 않습니다. 실패 작업은 자동 재실행하지 않습니다. 로컬 세션을 확인한 뒤 웹에서 재승인합니다. CLI stderr는 인증정보가 포함될 수 있어 공유 서버로 전송하지 않습니다.
