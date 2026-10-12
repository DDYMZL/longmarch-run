@echo off
setlocal
cd /d "%~dp0"
set "ROOT=%~dp0"
set "COMPOSE=docker compose -f docker\compose.yml"

echo [1/3] openGauss database
docker info >nul 2>&1 || (echo Docker is not running, start Docker Desktop first. & goto :fail)
%COMPOSE% up -d || goto :fail
set "INIT_ID="
for /f %%i in ('%COMPOSE% ps -a -q database-init') do set "INIT_ID=%%i"
if not defined INIT_ID (echo database-init container not found. & goto :fail)
set "INIT_CODE="
for /f %%c in ('docker wait %INIT_ID%') do set "INIT_CODE=%%c"
if not "%INIT_CODE%"=="0" (
  echo database-init failed, exit code %INIT_CODE%:
  %COMPOSE% logs --tail 30 database-init
  goto :fail
)
echo database ready on 127.0.0.1:5118

echo [2/3] backend
if not exist backend\.venv\Scripts\python.exe (
  python -m venv backend\.venv || goto :fail
)
backend\.venv\Scripts\python -m pip install -q -r backend\requirements.txt || goto :fail
if not exist backend\.env copy backend\.env.example backend\.env >nul
call :port_in_use 8010
if errorlevel 1 (
  start "longmarch-backend" /d "%ROOT%backend" cmd /k ".venv\Scripts\python run.py"
) else (
  echo port 8010 already in use, skip starting backend
)

echo [3/3] admin
if not exist admin\node_modules (
  pushd admin
  call npm install || (popd & goto :fail)
  popd
)
call :port_in_use 5173
if errorlevel 1 (
  start "longmarch-admin" /d "%ROOT%admin" cmd /k "npm run dev"
) else (
  echo port 5173 already in use, skip starting admin
)

call :wait_port 8010 backend
call :wait_port 5173 admin
start "" http://localhost:5173

echo.
echo Backend : http://127.0.0.1:8010   Swagger: http://127.0.0.1:8010/docs
echo Admin   : http://localhost:5173
echo Mini program: open this folder in WeChat DevTools.
echo Close the backend/admin windows to stop them; database: %COMPOSE% stop
exit /b 0

:port_in_use
netstat -ano | findstr /r /c:":%1 .*LISTENING" >nul
exit /b %errorlevel%

:wait_port
for /l %%n in (1,1,60) do (
  call :port_in_use %1 && exit /b 0
  ping -n 2 127.0.0.1 >nul
)
echo %2 did not listen on port %1 within 60s, check its window.
exit /b 1

:fail
echo Startup failed.
pause
exit /b 1
