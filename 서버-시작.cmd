@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
rem Detect on the host, never inside the Docker container.
if not defined QUEUE_HOST_ADDRESS for /f "delims=" %%I in ('powershell -NoProfile -Command "foreach($c in Get-NetIPConfiguration){if($c.IPv4DefaultGateway -and $c.NetAdapter.Status -eq 'Up'){foreach($a in $c.IPv4Address){if($a.IPAddress -notlike '169.254.*' -and $a.IPAddress -ne '127.0.0.1'){$a.IPAddress;exit}}}}"') do set "QUEUE_HOST_ADDRESS=%%I"
if not defined QUEUE_HOST_ADDRESS set "QUEUE_HOST_ADDRESS=%COMPUTERNAME%"
set "QUEUE_LISTEN_ADDRESS=0.0.0.0"
docker compose up -d --build --wait
if errorlevel 1 goto failed
echo.
echo 서버가 실행되었습니다. 사용자에게 전달할 주소:
type .local\server-address.txt
echo 사용자는 웹에 사내 로그인한 뒤 내 PC 연결에서 파일을 발급받습니다.
echo .env의 OIDC 환경변수가 아직 없으면 로그인 설정 안내가 표시됩니다.
echo 다른 PC에서 사용할 서버 주소 설정은 docs\easy-start.md를 참고하세요.
pause
exit /b 0
:failed
echo Docker Desktop이 실행 중인지 확인하세요.
pause
exit /b 1
