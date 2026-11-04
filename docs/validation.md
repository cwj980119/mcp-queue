# 검증 기록

2026-11-04, Windows 호스트, Node.js 22.16.0, Docker Desktop Linux 엔진에서 확인했습니다.

| 항목 | 결과 | 범위 |
| --- | --- | --- |
| `npm test` | 테스트 4개 통과 | 실제 MCP SDK 클라이언트·서버, REST, WebSocket, SQLite, 관리자. OpenCode는 모의 서버 |
| `docker compose up -d --build --wait` | healthy | Linux 이미지 빌드, 비특권 사용자, 읽기 전용 루트, 볼륨 DB |
| `npm run test:compose` | 양방향 요청 2개·에이전트 실행 2회 | Compose 서버와 호스트 PC 관리자 2개. OpenCode 응답은 모의 서버 |
| Docker 기반 setup | 설정 묶음 생성 성공 | 기존 토큰을 덮어쓰지 않는 별도 경로로 확인 |
| `npm audit` | 알려진 취약점 0 | 해당 시점 lockfile 기준. 향후 변경 가능 |
| 실제 OpenCode 1.19.5 | API 계약 확인 성공 | 별도 임시 컨테이너, queue-reader 프로필 로딩, health/agent/session/doc. 모델 프롬프트 0회 |
| 웹 UI | 수신함·완료 답변·처리 이력 표시 확인 | localhost 브라우저에서 실제 Compose DB 조회 |

자동 테스트는 사람용·에이전트용·관리자용 권한 분리, 미공개 초안 차단, 동일 키 재시도·내용 충돌, 인수 중복 차단, 오래된 실행 결과 거부, 알림 이전 승인 작업의 시작 시 확인을 검증합니다. 네트워크 오류를 초안 저장 전과 저장 후에 각각 주입해, 결과 재전송·재조회가 에이전트를 중복 호출하지 않는지도 확인합니다.

실제 두 물리 PC, 사내 HTTPS 프록시, GLM-5.3 사내 API, 문서 MCP, 해당 문서의 접근·공유 권한은 이 환경에서 검증하지 않았습니다. 사용자별 설정이 필요한 남은 연결 확인 범위입니다. 실제 OpenCode에 모델 프롬프트를 보내 답변을 생성하는 구간도 모의 통합 테스트로만 확인했으며, 사내 API의 토큰·RPM 사용량을 측정하지 않았습니다.

테스트 요청은 `[SMOKE]` 제목으로 남습니다. 테스트 스크립트는 서버 DB나 볼륨을 지우지 않습니다. 토큰·DB·UI 확인 스크린샷은 `.local` 아래에 두어 Git에서 제외했습니다.
