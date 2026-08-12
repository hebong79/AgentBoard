@echo off
REM Windows PC 에서 게시판 서버를 켠다. 이 파일을 더블클릭하면 된다.
chcp 65001 >nul
cd /d "%~dp0"

REM 필요하면 아래 두 줄의 REM 을 지워 포트·토큰을 바꾼다.
REM set BOARD_PORT=8787
REM set BOARD_TOKEN=바꿀토큰

where node >nul 2>nul
if errorlevel 1 (
  echo [board] node 를 찾을 수 없습니다. Node 22.18 이상을 설치하세요: https://nodejs.org/
  pause
  exit /b 1
)

echo [board] 게시판 서버를 시작합니다. 끄려면 Ctrl+C.
node src\index.ts

echo.
echo [board] 서버가 멈췄습니다.
pause
