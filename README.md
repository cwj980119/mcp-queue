# MCP Queue

서로 다른 PC의 OpenCode·Claude Code 사용자가 업무를 요청하고, 수신자가 승인한 뒤 자신의 에이전트로 처리하고 답변을 검토·전송하는 프로그램입니다. 사내 문서는 각 에이전트에 이미 등록한 문서 MCP로 읽습니다.

**가입과 연결:** Queue 웹 접속 → 사내 OIDC 로그인 → 사용자 자동 등록 → ‘내 PC 연결’에서 연결 파일 다운로드 → PC 프로그램에 불러오기.

## 어디에 설치하나요?

| 위치 | 설치할 것 | 설정할 것 |
| --- | --- | --- |
| 중앙 서버 | Git, Docker Engine/Desktop, Compose v2 | `.env`의 서버 주소·OIDC 설정. GLM이나 에이전트 설치 불필요 |
| 각 사용자 PC | Node.js 22.16+, OpenCode 또는 Claude Code, 사용자 프로그램 ZIP | 기존 모델·문서 MCP 설정과 본인이 발급한 PC 연결 파일. Docker 불필요 |
| 사용자 브라우저 | 설치 없음 | 사내 계정으로 로그인. 승인·최종 전송 담당 |

## 서버 시작

```powershell
Copy-Item .env.example .env
# .env에 회사 서버 주소와 OIDC 정보를 입력한 후:
docker compose up -d --build --wait
```

모든 로그인 설정은 **환경변수**로 관리합니다. 최소 설정은 `QUEUE_SERVER_URL`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`입니다. 회사 인증 서비스에는 기본 콜백 `<QUEUE_SERVER_URL>/auth/callback`을 등록합니다. 기본 scope는 `openid profile email`입니다. 회사 서비스의 기존 로그인 세션이 있으면 별도 입력 없이 돌아올 수 있습니다.

OIDC 정보가 없으면 서버는 실행되지만 로그인을 허용하지 않습니다. Alice/Bob 계정을 자동 생성하지 않습니다. 사내 정보 없이 로컬에서 화면 흐름만 시험하려면 명시적으로 개발 모드를 사용합니다.

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
# http://localhost:3000 — 개발용 이름·이메일 로그인, localhost에만 공개
```

개발 모드는 사내 인증을 검증하지 않습니다. 공용 서버에 사용하지 않습니다. 운영 구성으로 돌아갈 때는 기본 Compose 명령을 다시 실행합니다. [전체 환경변수와 서버 운영](docs/server.md)을 참고하세요.

## 사용자 시작

1. 관리자가 알려준 **Queue 서버 웹 주소**에 접속해 사내 계정으로 로그인합니다. 최초 로그인 시 이름·이메일을 저장합니다.
2. **내 PC 연결 → PC 이름 입력 → 내 PC 연결 파일 다운로드**를 누릅니다.
3. 사용자 프로그램의 **사용자-시작.cmd**를 실행합니다. 성공한 [GitHub Actions](https://github.com/cwj980119/mcp-queue/actions)의 **Artifacts → mcp-queue-user**에서 ZIP을 받을 수 있습니다. 관리자가 ZIP을 전달해도 됩니다.
4. 연결 파일 불러오기 → OpenCode/Claude Code 선택 → 프로젝트 폴더 지정 → 문서 검색·읽기 기능 선택 → **연결하고 시작**.
5. **내 요청함 열기**에서 요청을 보내거나, 받은 요청의 **실행 승인 → 초안 검토 → 최종 전송**을 진행합니다.

다음부터는 사용자 시작 파일을 실행하고 **관리자 시작**을 누릅니다. PC 프로그램과 PC가 켜져 있어야 승인된 업무를 처리합니다. OpenCode의 로컬 포트와 비밀번호는 프로그램이 관리하므로 4096에 접속하거나 서버를 따로 켤 필요가 없습니다. Claude Code는 CLI를 사용합니다. [간편 사용 안내](docs/easy-start.md).

## 인증과 저장

- 계정은 OIDC의 `issuer + sub`로 식별합니다. 이름·이메일 변경으로 새 계정이 생기지 않습니다.
- 브라우저는 HttpOnly 세션 쿠키를 사용합니다. 에이전트에 사람용 키를 전달하지 않습니다.
- PC별 agent·worker 키는 발급 시 한 번 다운로드되고, 서버에는 해시만 저장합니다. 기본 만료 90일이며 웹에서 본인 PC 연결을 폐기할 수 있습니다.
- PC 정보는 표준 `openid profile email`에 포함된 정보가 아닙니다. 회사가 제공하는 별도 클레임 이름을 `OIDC_DEVICE_ID_CLAIM`, `OIDC_DEVICE_NAME_CLAIM`으로 지정합니다. 없으면 사용자가 PC 이름을 입력합니다. PC 클레임은 참고 메타데이터이며 키를 물리적 PC에 고정하는 장치 인증은 아닙니다.
- DB에는 사용자 정보, 세션, PC 키 해시와 질문·초안·회신을 보관합니다. 회사 OIDC의 ID/access/refresh token은 DB에 보관하지 않습니다.

## 구조와 범위

서버는 TypeScript·Express·공식 MCP SDK·SQLite·WebSocket으로 구성하고, 웹은 HTML/CSS/JavaScript를 사용합니다. OIDC는 `openid-client`로 구현했습니다. PC 관리자는 이벤트가 오면 승인된 작업을 인수하고 OpenCode HTTP API 또는 Claude Code CLI를 실행합니다. **대기 중 LLM 호출과 토큰 사용은 없습니다.**

사용자는 동적으로 등록할 수 있고 사용자당 동시 실행은 1개입니다. 같은 계정에 PC를 여러 개 연결하면 먼저 인수한 PC가 실행합니다. 지정 PC 선택, 워크그룹, 역할 위임, 다중 서버, 계정 비활성화의 OIDC 로그아웃 연동은 아직 구현하지 않았습니다. 키 폐기는 서버 접근을 차단하지만 이미 실행 중인 로컬 프로세스는 종료하지 않습니다. 실패한 업무는 자동 재실행하지 않습니다.

[구조·권한·실패 처리](docs/architecture.md), [재사용 오픈소스와 라이선스](THIRD_PARTY_NOTICES.md).

## 검증

```powershell
npm.cmd ci
npm.cmd test
```

모의 OIDC 제공자로 PKCE·state·nonce·ID 토큰 서명·audience·UserInfo subject 검증과 등록·재로그인·PC 키 만료·폐기·권한 분리를 확인합니다. OpenCode/Claude Code의 모의 런타임으로 양방향 요청·승인·초안·최종 회신을 검사합니다. 실제 회사 OIDC·GLM·사내 문서 서비스와의 호환성은 해당 환경변수와 사용자 설정을 넣은 후 확인해야 합니다.

과거 정적 토큰 방식은 `AUTH_MODE=legacy`에서만 사용할 수 있습니다. [기존 OpenCode 수동 설치](docs/user.md)와 [Claude 수동 설치](docs/claude-code.md)는 기존 설치의 참고 자료입니다. 새 설치는 위의 사내 로그인·PC 연결 화면을 사용하세요.
