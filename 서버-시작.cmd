@echo off
chcp 65001 >nul
cd /d "%~dp0"
docker compose up -d --build --wait
if errorlevel 1 goto failed
echo.
echo 서버가 실행되었습니다: http://localhost:3000
echo .local\connections 폴더에서 각 사용자에게 본인의 연결 파일만 전달하세요.
echo 다른 PC에서 사용할 서버 주소 설정은 docs\easy-start.md를 참고하세요.
pause
exit /b 0
:failed
echo Docker Desktop이 실행 중인지 확인하세요.
pause
exit /b 1
