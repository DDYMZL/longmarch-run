@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "ROOT=%~dp0"
set "COMPOSE=docker compose -f docker\compose.yml"

echo ==========================================================
echo  longmarch-run - local development startup
echo  database + backend + admin, with config preflight
echo ==========================================================
echo.

echo [1/5] openGauss database
docker info >nul 2>&1 || (echo Docker is not running, start Docker Desktop first. & goto :fail)
%COMPOSE% up -d || goto :fail
set "INIT_ID="
for /f %%i in ('%COMPOSE% ps -a -q database-init') do set "INIT_ID=%%i"
if not defined INIT_ID (echo database-init container not found. & goto :fail)
set "INIT_CODE="
for /f %%c in ('docker wait %INIT_ID%') do set "INIT_CODE=%%c"
if not "!INIT_CODE!"=="0" (
  echo database-init failed, exit code !INIT_CODE!:
  %COMPOSE% logs --tail 30 database-init
  goto :fail
)
echo   ready on 127.0.0.1:5118
set "LAST_SQL="
for /f "delims=" %%F in ('dir /b /a-d /o:n docker\init\*.sql') do set "LAST_SQL=%%F"
echo   docker\init holds migrations up to !LAST_SQL!
echo   database-init only applies versions missing from schema_migrations
echo.

echo [2/5] backend
if not exist backend\.venv\Scripts\python.exe (
  python -m venv backend\.venv || goto :fail
)
backend\.venv\Scripts\python -m pip install -q -r backend\requirements.txt || goto :fail
if not exist backend\.env (
  copy backend\.env.example backend\.env >nul
  echo   created backend\.env from .env.example
)
call :ai_config
call :port_in_use 8010
if errorlevel 1 (
  start "longmarch-backend" /d "%ROOT%backend" cmd /k ".venv\Scripts\python run.py"
) else (
  echo   port 8010 already in use, skip starting backend
  echo   a leftover process keeps serving the OLD code - if the smoke test
  echo   below reports a stale route, kill python run.py AND its reload child
)
echo.

echo [3/5] admin
if not exist admin\node_modules (
  pushd admin
  call npm install || (popd & goto :fail)
  popd
)
call :port_in_use 5173
if errorlevel 1 (
  start "longmarch-admin" /d "%ROOT%admin" cmd /k "npm run dev"
) else (
  echo   port 5173 already in use, skip starting admin
)
echo.

echo [4/5] mini program target - frontend\services\config.js
set "DEV_TARGET="
set "LAN_IP="
for /f "tokens=2 delims='" %%A in ('findstr /c:"const DEV_TARGET" frontend\services\config.js') do set "DEV_TARGET=%%A"
for /f "tokens=2 delims='" %%A in ('findstr /c:"const LAN_IP" frontend\services\config.js') do set "LAN_IP=%%A"
if not defined DEV_TARGET (
  echo   [WARN] DEV_TARGET not readable from config.js, check that file by hand
  goto :mini_done
)
if "!DEV_TARGET!"=="local" (
  echo   DEV_TARGET = local
  echo     DevTools    -^> http://127.0.0.1:8010/api
  echo     real device -^> http://!LAN_IP!:8010/api
  echo     a real device also needs the same Wi-Fi and "do not verify legal
  echo     domain" ticked in DevTools local settings; update LAN_IP when this
  echo     machine changes network
) else (
  echo   DEV_TARGET = !DEV_TARGET!
  echo     DevTools and real devices call https://swkjdj.sz-watech.com/api,
  echo     NOT the backend started here. To debug against 127.0.0.1:8010 set
  echo     DEV_TARGET = 'local' in frontend\services\config.js and recompile.
  echo     Keep 'remote' for the automator suites and do not commit 'local'.
)
echo   trial and release builds ignore DEV_TARGET and always use the deployed backend
:mini_done
echo.

echo [5/5] waiting for services
call :wait_port 8010 backend
call :wait_port 5173 admin
start "" http://localhost:5173
call :smoke
echo.
echo Backend      : http://127.0.0.1:8010    Swagger: http://127.0.0.1:8010/docs
echo Admin        : http://localhost:5173
echo Mini program : open this folder in WeChat DevTools
echo Release build: build-prod.bat
echo Stop         : close the backend/admin windows; database: %COMPOSE% stop
exit /b 0

:ai_config
set "AI_MISSING="
for %%K in (CLOUDBASE_ENV_ID CLOUDBASE_AGENT_ID CLOUDBASE_API_KEY) do (
  findstr /r /c:"^%%K=..*" backend\.env >nul 2>&1
  if errorlevel 1 set "AI_MISSING=!AI_MISSING!%%K "
)
if defined AI_MISSING (
  echo   [WARN] AI center not configured in backend\.env - missing or empty: !AI_MISSING!
  echo       /api/ai/* and admin AI generation answer 403 without them. Put the real
  echo       CLOUDBASE_* values in backend\.env only - that file is gitignored. Never
  echo       write the API Key into .env.prod, the mini program or the admin build.
) else (
  echo   AI center configured: CLOUDBASE_ENV_ID, CLOUDBASE_AGENT_ID, CLOUDBASE_API_KEY
)
findstr /r /c:"^AI_ENABLED=false" backend\.env >nul 2>&1
if not errorlevel 1 echo   [WARN] AI_ENABLED=false in backend\.env - AI endpoints are switched off
findstr /r /c:"^ADMIN_PASSWORD=..*" backend\.env >nul 2>&1
if errorlevel 1 echo   note: ADMIN_PASSWORD is empty, so admin login by password is disabled
exit /b 0

:smoke
where curl >nul 2>&1
if errorlevel 1 exit /b 0
set "C1="
set "C2="
for /f "delims=" %%C in ('curl -s -o nul -w "%%{http_code}" --max-time 10 http://127.0.0.1:8010/api/activity/status') do set "C1=%%C"
for /f "delims=" %%C in ('curl -s -o nul -w "%%{http_code}" --max-time 10 http://127.0.0.1:8010/api/ai/conversations') do set "C2=%%C"
echo   smoke /api/activity/status  = !C1!  expect 200
echo   smoke /api/ai/conversations = !C2!  expect 401; 404 means the process on 8010
echo                                     predates the AI center and must be restarted
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
echo.
echo Startup failed.
pause
exit /b 1
