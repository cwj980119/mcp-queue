# 서버 설치 및 운영

## 설치 범위

중앙 서버에는 Git, Docker Engine(Windows는 Docker Desktop), Docker Compose v2가 필요합니다. Node.js, OpenCode, GLM 키, 사내 문서 MCP, 별도 Redis/PostgreSQL은 필요하지 않습니다. 설치하는 서비스는 `server` 컨테이너 하나이며 SQLite는 `queue-data` 볼륨에 저장합니다.

## 최초 설정

```powershell
git clone https://github.com/cwj980119/mcp-queue.git
cd mcp-queue
Copy-Item .env.example .env
```

`.env`의 `QUEUE_SERVER_URL`을 사용자 두 PC가 접속할 실제 HTTPS 주소로 설정합니다. 같은 PC에서만 시험할 때는 기본값을 사용합니다. `.env`는 Compose 설정이며 PC 관리자는 이 파일을 읽지 않습니다.

Windows:

```powershell
docker compose --profile tools run --rm setup
docker compose up -d --build --wait
docker compose ps
```

Linux에서는 최초 설정 파일이 운영자 소유가 되도록 UID/GID를 지정합니다. 아래 환경변수는 그 셸에서만 유효합니다.

```sh
export QUEUE_UID=$(id -u)
export QUEUE_GID=$(id -g)
docker compose --profile tools run --rm setup
docker compose up -d --build --wait
docker compose ps
```

`setup`은 운영자와 같은 UID로 저장소에 쓸 수 있어야 합니다. root가 아닌 Linux 계정에서는 `.env`의 QUEUE_UID/GID도 본인의 값으로 맞추거나 위 환경변수를 사용하세요. Windows Docker Desktop에서는 기본 0:0 설정으로 초기화할 수 있습니다. 해시만 담은 `auth.json`은 컨테이너의 비특권 사용자도 읽을 수 있습니다.

Node.js가 이미 설치된 서버에서는 Docker 초기화 대신 `npm run setup`도 가능합니다. 두 방식을 동시에 수행할 필요는 없습니다. 기존 `.local/auth.json`이 있으면 setup은 오류로 종료하여 덮어쓰기를 막습니다.

## 생성 파일과 전달

| 파일 | 위치와 용도 |
| --- | --- |
| `.local/auth.json` | 서버 전용. 사용자·역할·SHA-256 토큰 해시. 원문 토큰은 없음 |
| `.local/alice/human-token.txt` | A의 브라우저 로그인, 승인·전송 권한 |
| `.local/alice/opencode-mcp.json` | A의 OpenCode에 병합할 MCP 설정. 에이전트 토큰 |
| `.local/alice/manager.json` | A PC 관리자 설정. 작업 인수·초안 제출용 토큰 |
| `.local/bob/*` | B에게만 전달하는 같은 종류의 파일 |
| 각 사용자 폴더의 `claude-mcp.json`, `manager.claude.json` | Claude Code를 선택한 사용자의 Queue MCP·CLI 관리자 설정. 같은 사용자 토큰 사용 |

운영자가 각 사용자에게 자신의 폴더만 회사의 안전한 전달 방법으로 전달합니다. 저장소는 비공개지만 `.local`과 `.env`는 Git에 넣지 않습니다. 설치 작업 완료 후 원문 토큰 묶음은 운영자가 접근을 제한하거나 회사의 비밀 저장소로 옮기고, 실행 서버에는 `auth.json`만 유지할 수 있습니다.

프로토타입의 사용자 ID는 `alice`, `bob`입니다. 표시 이름은 auth.json에서 바꿀 수 있습니다. 사용자를 동적으로 등록하는 관리자 UI는 없습니다. 토큰 교체는 새 무작위 토큰의 해시를 해당 역할에 반영하고, 그 역할의 사용자 설정을 갱신한 뒤 서버를 재시작합니다. `setup`을 다시 실행해 전체 자격증명을 재발급하는 방식은 사용하지 마세요.

## 다른 PC에서 접속

기본 포트는 `127.0.0.1:3000`입니다. 서버에 이미 있는 회사 HTTPS 리버스 프록시가 `http://127.0.0.1:3000`으로 전달하도록 설정하는 방법을 권장합니다. 프록시는 서버와 같은 호스트 또는 접근 가능한 전용 네트워크에 둡니다.

- HTTP API `/api/*`, MCP `/mcp`, 웹 `/` 모두 같은 도메인에 연결합니다.
- WebSocket `/events`에 Upgrade를 지원합니다.
- 원래 `Host`를 보존합니다. WebSocket은 브라우저 Origin의 host와 Host를 비교합니다.
- OpenCode가 사용하는 MCP POST 요청을 허용합니다. 이 서버는 stateless Streamable HTTP를 사용하며 별도 GET SSE 세션은 제공하지 않습니다.

기존 Nginx의 예시 location입니다. TLS 인증서와 server_name은 회사 설정을 사용합니다.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}
```

프록시가 다른 컨테이너에 있다면 localhost는 그 컨테이너를 가리킵니다. 같은 Docker 네트워크에서 `http://server:3000`으로 연결하거나 회사 네트워크에 맞춰 조정합니다. 내부망 직접 연결은 `.env`의 `BIND_ADDRESS`로 바꿀 수 있지만 원문 토큰이 전송되므로 HTTPS 또는 회사의 암호화 터널을 사용합니다. 설치 스크립트는 방화벽이나 사내 프록시를 변경하지 않습니다.

서버 URL을 최초 설정 이후 바꿨다면 각 사용자 `manager.json`의 `serverUrl`과 OpenCode MCP 설정의 `url`도 함께 수정합니다. 사용자 PC의 `localhost:3000`은 중앙 서버가 아니라 그 PC를 의미합니다.

## 상태·로그·업데이트

```powershell
docker compose ps
docker compose logs --tail 100 server
docker compose restart server
```

`GET /health`는 인증 없이 최소 상태만 반환합니다. 요청 본문·토큰을 액세스 로그에 남기지 않습니다. 업데이트는 변경 사항을 검토한 뒤 `git pull` 및 `docker compose up -d --build --wait`로 적용합니다. SQLite 스키마 변경 시에는 별도의 마이그레이션을 추가해야 하며 현재 버전은 최초 스키마만 제공합니다.

## 백업

DB는 컨테이너 삭제와 독립적인 볼륨에 있지만 볼륨 삭제는 데이터 손실입니다. `.local/auth.json`과 DB를 함께 보관해야 사용자 매핑을 유지할 수 있습니다. 서버의 auth.json에는 해시만 있어 사용자 원문 토큰을 복구할 수 없습니다.

가장 간단한 백업은 짧게 서버를 멈추고 **data 디렉터리 전체**를 복사하는 것입니다. 실행 중인 SQLite 본체 파일 하나만 복사하면 WAL의 변경 사항이 누락될 수 있습니다.

```powershell
docker compose stop server
$queueContainer = docker compose ps -a -q server
docker cp "${queueContainer}:/data" .local/backup-data
docker compose start server
```

백업에는 질문·답변·초안이 포함되므로 서버 DB와 같은 접근 정책을 적용합니다. `docker compose down`은 컨테이너를 중지·삭제하지만 기본적으로 named volume을 보존합니다. `down -v`는 이 프로젝트의 DB도 제거하므로 일반 종료 명령으로 사용하지 않습니다.

## 자원

두 사용자용 시작 예산은 vCPU 1개, RAM 512 MB, 디스크 1 GB이며 LLM GPU는 필요하지 않습니다. 이는 여유를 둔 예산이지 부하 테스트 보장은 아닙니다. 요청 본문·답변 크기와 보관 기간에 따라 디스크가 증가합니다. 현재 검증 환경에서 서버 컨테이너의 유휴 메모리는 약 39 MiB, CPU 표시는 0.00%였습니다. Docker Desktop VM의 메모리·디스크 비용은 별도입니다.
