# 서버 설치 및 운영

서버에는 Git, Docker Engine/Desktop, Docker Compose v2가 필요합니다. Node.js·에이전트·GLM·문서 MCP는 사용자 PC에서 사용합니다. 서버는 단일 애플리케이션과 SQLite 볼륨만 실행합니다.

## 환경변수

`.env.example`을 `.env`로 복사해 설정하거나 배포 환경에서 주입합니다. `.env`는 Git과 사용자 ZIP에 포함하지 않습니다. 아래 값이 준비되지 않았어도 개발은 가능하며, 운영 로그인은 설정이 완성될 때까지 닫혀 있습니다.

| 변수 | 기본값 / 용도 |
| --- | --- |
| `AUTH_MODE` | `oidc`. `development`는 명시적 localhost 시험용, `legacy`는 기존 정적 토큰 설치 전용 |
| `QUEUE_SERVER_URL` | 사용자가 접근하는 서버의 루트 HTTPS 주소. 프록시 주소를 명시하는 것을 권장. 빈 값은 bootstrap이 감지한 주소 사용 |
| `OIDC_ISSUER_URL` | 회사 발급자 URL. discovery 문서의 issuer와 정확히 일치해야 함 |
| `OIDC_DISCOVERY_URL` | 선택. 기본 discovery 경로가 다른 경우 전체 URL. issuer도 별도 지정 |
| `OIDC_CLIENT_ID` | 회사 OIDC에 등록한 Queue 웹 애플리케이션 ID |
| `OIDC_CLIENT_SECRET` | 서버에서만 주입. 채팅·사용자 연결 파일에 넣지 않음 |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic`. 회사 설정에 맞춰 `client_secret_post` 또는 `none` 지원 |
| `OIDC_SCOPES` | `openid profile email`. 추가 scope를 지정해도 이 세 scope는 유지 |
| `OIDC_REDIRECT_URI` | 기본 `<QUEUE_SERVER_URL>/auth/callback`. 같은 origin의 콜백만 허용 |
| `OIDC_PROMPT` | 선택. 기본은 파라미터 생략하여 회사 SSO 세션 재사용. `none`은 미로그인 사용자의 인증 실패를 유발할 수 있음 |
| `OIDC_AUTO_LOGIN` | `true`. 비로그인 웹 접속 시 회사 로그인으로 이동. `false`면 버튼 클릭 시 이동 |
| `OIDC_DEVICE_ID_CLAIM` | 선택. 회사가 주는 PC 식별자 클레임. 예: `device_id`, `pc.id` |
| `OIDC_DEVICE_NAME_CLAIM` | 선택. 회사가 주는 PC 표시 이름 클레임. 예: `pc.name` |
| `SESSION_TTL_SECONDS` | `28800` (8시간), 60~604800 |
| `DEVICE_KEY_TTL_DAYS` | `90`, 1~3650 |
| `CLIENT_WINDOWS_DOWNLOAD_URL` | 선택. 설치 파일의 사내 HTTPS 미러 URL. 기본은 GitHub 최신 Release의 `MCP-Queue-Setup.exe` |
| `OIDC_ALLOW_HTTP_LOCALHOST` | `false`. `true`여도 HTTP는 localhost OIDC 시험에만 허용. 사내 HTTP를 허용하는 우회 옵션이 아님 |
| `PORT` | 호스트 공개 포트 `3000`. 컨테이너 내부는 3000 |
| `BIND_ADDRESS` | 직접 Compose는 `127.0.0.1`. HTTPS 프록시가 같은 호스트에 있으면 유지 |
| `QUEUE_HOST_ADDRESS` | IP 자동 감지 보정용. `QUEUE_SERVER_URL`이 우선 |
| `QUEUE_UID`, `QUEUE_GID` | Linux 생성 파일의 소유자 보정, 보통 자동 감지 |

OIDC 클라이언트는 **Authorization Code + PKCE(S256)**를 사용합니다. 회사 관리자에게 콜백 URI와 scope를 등록합니다. ID 토큰의 서명·issuer·audience·nonce를 확인하고, UserInfo를 사용할 때 subject 일치를 확인합니다. `issuer + sub`를 계정 키로 사용하므로 이메일을 기준으로 기존 계정을 합치지 않습니다. `profile/email`은 이름·이메일을 제공하는 표준 scope이며 PC 정보는 별도 회사 클레임이 필요합니다.

## 실행

```powershell
docker compose up -d --build --wait
docker compose ps
```

`서버-시작.cmd` / `sh 서버-시작.sh`는 호스트 IP와 포트를 감지합니다. 회사 HTTPS URL은 `.env`의 `QUEUE_SERVER_URL`로 명시하세요. 시작 파일은 명시한 `BIND_ADDRESS`를 유지하며, 없으면 LAN 바인딩을 선택합니다. HTTPS 프록시를 같은 서버에서 사용할 때는 `BIND_ADDRESS=127.0.0.1`을 권장합니다. 스크립트가 회사 DNS·TLS·방화벽을 변경하지는 않습니다.

bootstrap은 주소 파일과 빈 legacy 해시 파일을 준비하며 OIDC 모드에서는 샘플 계정·원문 키 파일을 만들지 않습니다. 사용자·세션·PC 등록·키 해시는 `queue-data` 볼륨에 저장됩니다. 사용자는 최초 로그인에 자동 등록되고 ‘내 PC 연결’에서 자신의 파일을 발급합니다. 관리자가 사용자별 토큰을 만들어 배포할 필요가 없습니다.

환경변수를 바꾼 뒤에는 restart가 아니라 다음 명령으로 적용합니다.

```powershell
docker compose up -d --build --force-recreate --wait
```

서버의 외부 URL이 바뀌면 회사 OIDC의 콜백 등록도 변경하고 사용자 PC의 연결 파일/주소도 갱신합니다. 이미 전달한 파일의 주소가 자동 수정되지는 않습니다.

## 다른 PC에서 접속

회사 HTTPS 프록시가 같은 서버의 `http://127.0.0.1:3000`으로 전달하도록 구성합니다. `/`, `/auth/*`, `/api/*`, `/mcp`, WebSocket `/events`를 모두 전달하고 원래 Host를 보존합니다. 루트 경로 배포만 지원합니다.

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

프록시가 다른 컨테이너라면 localhost는 해당 컨테이너이므로 같은 Docker 네트워크의 `http://server:3000` 등으로 조정합니다. 기본 프록시 설정만으로 TLS 인증서나 회사 DNS가 생기지는 않습니다.

회사 CA가 Node의 기본 신뢰 목록에 없다면 CA 파일을 서버 컨테이너에 읽기 전용 마운트하고 `NODE_EXTRA_CA_CERTS` 환경변수로 경로를 지정합니다. 사용자 프로그램에도 같은 회사 CA 신뢰 설정이 필요할 수 있습니다. TLS 검증을 끄지 않습니다.

## 회사 정보 없이 로컬 시험

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
```

`http://localhost:3000`에서 이름·이메일로 시험합니다. 이 모드는 OIDC 없이 동작하고 신원을 검증하지 않습니다. 개발 override가 바인딩을 loopback으로 강제합니다. 개발 모드 데이터는 같은 볼륨에 남지만 issuer가 달라 회사 계정과 합쳐지지 않습니다. 기본 Compose로 다시 실행하면 운영 OIDC 모드로 돌아갑니다.

## 키와 세션

PC 키는 기본 90일 유효하며 다운로드 시 원문을 한 번만 반환합니다. 서버에는 해시를 저장합니다. 만료·분실 시 웹에서 기존 PC 연결을 폐기하고 다시 발급합니다. 웹 세션은 기본 8시간이며 로그아웃하면 해당 Queue 세션이 무효화됩니다. 회사 전체 SSO 로그아웃이나 계정 비활성화의 실시간 연동은 아직 없습니다. 회사에서 퇴사자를 차단해도 이미 발급된 Queue 세션·PC 키는 자체 만료/폐기까지 남을 수 있으므로 실제 운영 전 관리자 계정 차단 정책을 추가해야 합니다.

키 폐기 이후 REST는 즉시 거부하고 기존 WebSocket은 다음 알림 또는 30초 이내 연결 검사에서 종료합니다. 이미 로컬에서 수행 중인 모델·도구 프로세스까지 종료하지 않습니다. 같은 사용자 PC가 여러 개면 사용자당 한 작업만 원자적으로 인수하며 결과는 인수한 PC에서만 제출합니다. 지정 PC 라우팅은 아직 없습니다.

PC 클레임은 로그인 때 받은 참고 메타데이터입니다. 브라우저에서 다운로드한 키는 다른 PC로 복사할 수 있으므로 이것만으로 물리적 PC 고정이나 장치 보증을 제공하지 않습니다. 요청자의 IP로 수신자를 판단하지 않습니다.

## 상태·백업

```powershell
docker compose logs --tail 100 server
# 종료 (볼륨 보존):
docker compose down
```

`GET /health`는 프로세스 상태입니다. OIDC 연결 성공 여부는 아닙니다. `/auth/config`에서 설정 누락을 확인할 수 있습니다. 오류 화면에는 상세 인증 토큰을 표시하지 않습니다. 실제 회사 제공자와의 호환성은 설정 후 로그인으로 확인하세요.

SQLite 백업은 서버를 잠시 멈추고 data 디렉터리 전체를 복사합니다. WAL 사용 중 본체 파일만 복사하지 않습니다.

```powershell
docker compose stop server
$queueContainer = docker compose ps -a -q server
docker cp "${queueContainer}:/data" .local/backup-data
docker compose start server
```

DB에는 개인정보·세션·질문·초안·답변이 들어 있으므로 접근을 제한합니다. `down -v`는 DB를 삭제합니다. 일반 종료에 사용하지 마세요. OIDC client secret은 별도 비밀 저장소/환경변수에서 복구합니다.

## 기존 정적 토큰 설치

기존 파일은 삭제하지 않습니다. 단, 기본 OIDC 모드에서는 `.local/auth.json`의 기존 토큰을 인증에 사용하지 않습니다. 기존 사용자 이름과 OIDC 계정을 이메일로 자동 병합하지도 않습니다. 기존 배포를 유지할 때만 `AUTH_MODE=legacy`로 실행합니다. legacy smoke 검증도 이 모드 전용입니다.

두 사용자 규모의 시작 예산은 vCPU 1개·RAM 512MB·디스크 1GB이며 실측 부하 보장은 아닙니다. 중앙 서버는 LLM을 호출하지 않고 Docker Desktop VM 비용은 별도입니다.
