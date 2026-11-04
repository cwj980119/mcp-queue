# 사용자 PC 설치

각 PC에서 같은 절차를 수행합니다. A는 alice, B는 bob 설정만 사용합니다. 관리자에게 받은 폴더에는 본인 역할별 토큰이 들어 있습니다.

이 문서는 **OpenCode 사용자**용입니다. **Claude Code 사용자**는 [별도 연결 안내](claude-code.md)를 따르세요. 두 도구의 사용자가 같은 서버에서 통신할 수 있습니다.

브라우저 요청함은 **Queue 서버 주소**(로컬 시험은 `http://localhost:3000`)입니다. `127.0.0.1:4096`은 해당 PC에서 OpenCode를 실행했을 때만 열리는 로컬 API 주소입니다. 이 프로젝트가 OpenCode를 자동 기동하지 않습니다. Claude Code에는 4096 포트가 필요 없습니다.

## 설치할 것

- Node.js **22.16 이상**과 npm. Windows에서는 PowerShell 실행 정책과 무관하게 `npm.cmd`를 사용할 수 있습니다.
- 기존 사용 중인 OpenCode. 여기서는 [공식 HTTP 서버 API](https://opencode.ai/docs/server/)의 `/global/health`, `/agent`, `/session`, `/session/:id/message`를 사용합니다. 이 API 형태를 제공하는 OpenCode 1.x 계열을 대상으로 합니다. 다른 API 세대는 어댑터 확인이 필요합니다.
- 기존 GLM 사내 API 연결과 사내 문서 MCP 설정.
- 이 저장소의 코드. Git clone이 편리하며 ZIP 전달도 가능합니다.

Docker, Rust, Python, 별도 메시지 브로커, OpenCode 플러그인, 무한 반복 skill은 필요하지 않습니다.

```powershell
git clone https://github.com/cwj980119/mcp-queue.git
cd mcp-queue
npm.cmd ci
npm.cmd run build
```

관리자에게 받은 자신의 bob 폴더를 `.local/bob`에 둡니다. A는 `.local/alice`입니다. **사용자 PC에서 `npm run setup`을 실행하지 마세요.** 서버가 발급한 토큰과 다른 새 토큰이 만들어집니다.

## 1. MCP 추가

기존 OpenCode 프로젝트의 `opencode.json`/`opencode.jsonc`에 `.local/bob/opencode-mcp.json`의 `mcp.queue` 항목을 병합합니다. 기존 GLM 제공자와 다른 MCP 설정은 유지합니다.

```json
{
  "mcp": {
    "queue": {
      "type": "remote",
      "url": "https://queue.company.example/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer YOUR_OWN_AGENT_TOKEN" }
    }
  }
}
```

실제 생성 파일에는 본인의 토큰이 들어 있습니다. 설정을 프로젝트 저장소에 커밋하지 않거나 [OpenCode 환경변수 참조](https://opencode.ai/docs/mcp-servers/#disabling-oauth) `"Bearer {env:QUEUE_AGENT_TOKEN}"`를 사용하세요. 사람용·관리자용 토큰은 OpenCode 설정에 넣지 않습니다.

```powershell
opencode mcp list
```

`list_users`, `create_request`, `list_requests`, `get_request` 네 도구가 제공됩니다. MCP만 등록해서는 자동 실행되지 않습니다. 아래 PC 관리자가 알림을 받아 실행 API를 호출합니다.

## 2. 문서 읽기 전용 실행 설정

`examples/opencode-reader.json`의 `agent.queue-reader`를 같은 OpenCode 설정에 병합합니다. 이 설정은 별도 LLM 설치나 상주 에이전트를 추가하는 것이 아니라, 동일 OpenCode 실행에 사용할 권한 프로필입니다.

예제의 `REPLACE_DOCS_MCP_NAME_search`, `REPLACE_DOCS_MCP_NAME_read`는 **실제 MCP 도구의 전체 이름**으로 교체합니다. 예를 들어 사내 MCP가 `corpdocs`이고 읽기 도구가 `search_documents`, `get_document`라면 다음처럼 지정합니다.

```json
{
  "agent": {
    "queue-reader": {
      "description": "승인받은 사내 문서 질문의 답변 초안",
      "mode": "primary",
      "steps": 12,
      "permission": {
        "*": "deny",
        "corpdocs_search_documents": "allow",
        "corpdocs_get_document": "allow"
      }
    }
  }
}
```

전체 `corpdocs_*`를 허용하면 쓰기·삭제 도구도 열릴 수 있으므로 읽기에 필요한 도구만 명시합니다. 도구 이름은 실제 서비스에 따라 다릅니다. OpenCode의 [권한 규칙](https://opencode.ai/docs/permissions/)과 [에이전트 설정](https://opencode.ai/docs/agents/)에 따라 적용합니다. 예제는 기본적으로 도구 실행을 막으며, 자리표시자만 그대로 두면 문서를 읽을 수 없습니다.

PC 관리자는 지정된 이름의 에이전트가 존재하는지 확인하고, 없으면 작업을 실패 처리합니다. Build로 자동 대체하거나 권한을 `allow`로 바꾸지 않습니다. 다만 관리자가 권한 구성 전체를 감사하는 것은 아니므로 사용자 설정을 확인해야 합니다. 프롬프트만으로 파일 쓰기나 도구 사용을 차단한다고 가정하지 않습니다.

## 3. 로컬 OpenCode 시작

기존 문서 MCP를 사용하는 **프로젝트 디렉터리**에서 실행하세요. 프로토타입은 서버를 자동으로 설치·기동하지 않습니다.

Windows PowerShell:

```powershell
$env:OPENCODE_SERVER_PASSWORD = 'LOCAL_STRONG_PASSWORD'
opencode --hostname 127.0.0.1 --port 4096
```

UI 없이 쓰려면 같은 위치에서 `opencode serve --hostname 127.0.0.1 --port 4096`을 사용합니다. TUI와 serve를 같은 포트에 동시에 실행하지 않습니다. TUI를 연결해 두면 저장된 세션과 도구 권한 문제를 확인하기 쉽습니다.

Linux/macOS:

```sh
export OPENCODE_SERVER_PASSWORD='LOCAL_STRONG_PASSWORD'
opencode --hostname 127.0.0.1 --port 4096
```

OpenCode API는 loopback에 둡니다. PC 관리자는 다른 호스트의 OpenCode URL을 거부합니다. 회사 GLM 키와 문서 MCP 인증정보는 기존 OpenCode 쪽에만 남습니다.

## 4. PC 관리자 설정 및 실행

`.local/bob/manager.json`을 수정합니다.

```json
{
  "runtime": "opencode",
  "serverUrl": "https://queue.company.example",
  "workerToken": "ADMIN_DELIVERED_WORKER_TOKEN",
  "opencodeUrl": "http://127.0.0.1:4096",
  "directory": "C:/work/existing-opencode-project",
  "opencodeUsername": "opencode",
  "opencodePassword": "LOCAL_STRONG_PASSWORD",
  "agent": "queue-reader",
  "timeoutMs": 600000,
  "reconcileMs": 60000
}
```

`directory`는 서버가 지정하지 않으며 각 PC 설정에 고정합니다. Windows JSON 경로는 `/` 또는 이스케이프한 `\\`를 사용합니다. OpenCode를 실제로 실행한 프로젝트와 일치시킵니다. 사용자 PC가 다른 경우 각자 경로가 달라도 됩니다.

기본 모델은 기존 OpenCode 설정을 따릅니다. 명시하려면 `model`에 `{ "providerID": "실제 제공자 ID", "modelID": "실제 GLM 모델 ID" }`를 추가합니다. `glm5.3` 같은 이름을 임의로 하드코딩하지 않았습니다.

```powershell
npm.cmd run manager -- .local/bob/manager.json
```

PC마다 관리자를 하나만 켜두는 것을 권장합니다. 서버가 사용자당 실행 중인 작업을 하나로 제한해 중복 관리자가 같은 작업을 인수하는 것도 방지합니다. 관리자가 꺼져 있어도 요청은 서버에 남습니다. 컴퓨터가 잠들면 실행되지 않으며, 깨어나 연결을 복구하면 승인된 요청을 확인합니다.

## 5. 승인·검토

서버의 웹 주소에 접속하고 본인의 `human-token.txt` 값을 입력합니다. 브라우저 새로고침 후에는 다시 입력해야 합니다.

- **받은 요청:** 요청 확인, 실행 승인, 거절, 초안 검토·수정, 최종 전송.
- **보낸 요청:** 상태·결과 확인, 실행 전 취소.
- **새 요청 보내기:** 에이전트를 쓰지 않고 직접 요청 작성.
- **처리 이력:** 승인자·실행·초안·전송 등 상태 변경 기록.

질문과 문서는 실행 입력 데이터로 취급합니다. 문서 접근 권한이 있어도 요청자에게 답변을 공유할 권한까지 자동으로 생기지는 않습니다. 최종 전송 전에 문서의 공유 범위를 확인하세요. 문서 MCP 원문은 직접 업로드하지 않지만 답변 초안에는 문서 내용 일부가 포함될 수 있습니다.

## 장애 시

| 상황 | 확인 |
| --- | --- |
| 승인해도 계속 실행 대기 | PC 관리자가 실행 중인지, serverUrl·workerToken이 맞는지 확인 |
| OpenCode HTTP 401 | OpenCode 시작 환경의 비밀번호와 manager.json의 비밀번호 일치 여부 |
| queue-reader가 없음 | 설정을 올바른 프로젝트에 병합했는지 확인하고 OpenCode 재시작 |
| 문서를 읽지 못함 | 해당 사용자의 문서 MCP 인증, 실제 읽기 도구 이름·권한 확인 |
| 연결이 끊긴 뒤 초안 미전송 | 관리자 로그와 `.local/outbox` 확인. 정상 연결 시 전송 재시도 |
| 실행 중 상태로 남음 | 웹에 표시된 OpenCode 세션을 로컬에서 확인. 종료/정리 후 중단 표시하고 필요할 때 재승인 |
| `.json.conflict` 결과 파일 | 이미 종료되거나 다른 실행으로 바뀐 작업의 늦은 결과. 파일 내용을 직접 확인하고 사용자 판단으로 처리 |

관리자 종료는 Ctrl+C입니다. 프로세스 강제 종료나 PC 전원 종료까지 복구를 보장하지는 않습니다. 완성된 답변을 디스크 outbox에 기록한 이후의 전송은 복구하지만, 그 전에 OpenCode 실행이 끝났는지 불확실하면 세션을 확인해야 합니다. outbox에는 초안이 있으므로 본인 계정만 접근하게 관리합니다. Linux 파일 권한은 0600/0700을 사용하며 Windows에서는 해당 폴더의 NTFS 접근 권한을 따릅니다.

## 연결 계약 확인(모델 호출 없음)

OpenCode를 위 설정으로 실행한 뒤 별도 터미널에서 다음을 수행할 수 있습니다.

```powershell
$env:OPENCODE_CONTRACT_URL = 'http://127.0.0.1:4096'
$env:OPENCODE_CONTRACT_PASSWORD = 'LOCAL_STRONG_PASSWORD'
npm.cmd run test:opencode-contract
```

상태·에이전트 목록·메시지 API 스키마를 확인하고 제목이 지정된 **빈 세션 하나**를 생성합니다. 모델 프롬프트나 문서 도구 호출은 하지 않습니다. OpenCode 1.19.5에서 확인했습니다. 이 검사는 GLM 인증이나 문서 읽기 성공까지 검증하지 않습니다. 실제 업무를 넣기 전에 공유 가능한 문서 한 개로 요청·승인·답변 검토·회신을 수행해 사내 연결을 확인하세요.

## 자원과 호출량

관리자는 대기 중에 LLM을 호출하지 않습니다. WebSocket 유지와 60초 REST 확인만 수행합니다. PC 관리자용 여유 예산은 RAM 128 MB이며 실제 OpenCode·문서 MCP 프로세스 비용은 별도입니다. GLM이 사내 공용 API이므로 이 프로젝트 때문에 로컬 GPU가 필요하지 않습니다.

한 사용자에게 60회/분 제한이 있어도 서버 알림은 모델 호출 수에 포함되지 않습니다. 작업 하나는 문서 도구 왕복·추론·OpenCode 내부 처리에 따라 여러 API 호출을 사용할 수 있습니다. 프로필의 12 steps는 추론 단계 상한을 낮추기 위한 설정이며, 전체 모델 요청 수를 정확히 12회로 보장하는 글로벌 RPM 제어가 아닙니다. 기존 수동 OpenCode 사용량과 합산한 정확한 사용량 제한·429 재시도는 GLM 클라이언트 또는 사내 게이트웨이 정책을 확인해야 합니다.
