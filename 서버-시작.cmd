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
echo .local\connections 폴더에서 각 사용자에게 본인의 연결 파일만 전달하세요.
echo 다른 PC에서 사용할 서버 주소 설정은 docs\easy-start.md를 참고하세요.
pause
exit /b 0
:failed
echo Docker Desktop이 실행 중인지 확인하세요.
pause
exit /b 1
