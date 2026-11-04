@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a<22||(a===22&&b<16)?1:0)"
if errorlevel 1 goto missing
if exist node_modules\jsonc-parser\package.json goto build
call npm.cmd ci
if errorlevel 1 goto failed
:build
call npm.cmd run build
if errorlevel 1 goto failed
call npm.cmd run client
pause
exit /b 0
:missing
echo Node.js 22 이상을 먼저 설치한 뒤 다시 실행하세요.
pause
exit /b 1
:failed
echo 준비 중 오류가 발생했습니다. 위 메시지를 확인하세요.
pause
exit /b 1
