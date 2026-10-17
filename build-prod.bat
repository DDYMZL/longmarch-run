@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "ROOT=%~dp0"

echo ==========================================================
echo  longmarch-run - production release build
echo  output: admin\dist.zip  backend-update.tar.gz  sql.tar.gz
echo ==========================================================
echo.

echo [1/6] preflight - git state
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo   [WARN] git not available, checks skipped
) else (
  set "DIRTY="
  for /f "delims=" %%L in ('git status --porcelain') do (
    if not defined DIRTY echo   uncommitted changes:
    set "DIRTY=1"
    echo     %%L
  )
  if not defined DIRTY echo   working tree clean

  set "AHEAD="
  for /f "delims=" %%N in ('git rev-list --count "@{u}..HEAD" 2^>nul') do set "AHEAD=%%N"
  if not defined AHEAD (
    echo   [WARN] no upstream branch, cannot tell what is unpushed
  ) else if "!AHEAD!"=="0" (
    echo   all local commits pushed
  ) else (
    echo   [WARN] !AHEAD! local commits NOT pushed to remote
  )

  git ls-files --error-unmatch docker/init/021_ai_center.sql >nul 2>&1
  if errorlevel 1 echo   [WARN] docker/init/021_ai_center.sql is NOT tracked by git
  git ls-files --error-unmatch docker/init/022_ai_admin_menus.sql >nul 2>&1
  if errorlevel 1 echo   [WARN] docker/init/022_ai_admin_menus.sql is NOT tracked by git
  echo       untracked migrations cannot reach the server via git pull;
  echo       they still ship inside sql.tar.gz below, so upload that package.
)
echo.

echo [2/6] preflight - backend\.env.prod
if not exist backend\.env.prod (
  echo   [x] backend\.env.prod not found
  goto :fail
)
findstr /r /c:"^CLOUDBASE_API_KEY=..*" backend\.env.prod >nul 2>&1
if errorlevel 1 echo   [WARN] CLOUDBASE_API_KEY is empty - AI endpoints will answer 403
findstr /c:"REPLACE_WITH" backend\.env.prod >nul 2>&1
if not errorlevel 1 (
  echo   [WARN] placeholder values still present:
  findstr /n /c:"REPLACE_WITH" backend\.env.prod
  echo       this file IS packaged into backend-update.tar.gz, so placeholders
  echo       would overwrite the real server values on deploy.
  set "CONT="
  set /p "CONT=   build anyway? y/N : "
  if /i not "!CONT!"=="y" goto :fail
) else (
  echo   no REPLACE_WITH placeholders
)
findstr /r /c:"^AI_ENABLED=false" backend\.env.prod >nul 2>&1
if not errorlevel 1 echo   [WARN] AI_ENABLED=false - AI center is switched off in this build
echo.

echo [3/6] admin - npm run build
where npm >nul 2>&1
if errorlevel 1 (
  echo   [x] npm not found in PATH
  goto :fail
)
if not exist admin\node_modules (
  echo   installing admin dependencies...
  pushd admin
  call npm install
  if errorlevel 1 ( popd & goto :fail )
  popd
)
pushd admin
call npm run build
if errorlevel 1 ( popd & goto :fail )
popd
if not exist admin\dist.zip (
  echo   [x] admin\dist.zip was not produced
  goto :fail
)
echo   ok: admin\dist.zip
echo.

echo [4/6] backend - package
call build-backend.bat
if errorlevel 1 goto :fail
if not exist backend-update.tar.gz (
  echo   [x] backend-update.tar.gz was not produced
  goto :fail
)
echo.

echo [5/6] sql - package
call build-sql.bat
if errorlevel 1 goto :fail
if not exist sql.tar.gz (
  echo   [x] sql.tar.gz was not produced
  goto :fail
)
echo.

echo [6/6] verify artifacts
set "MISSING="
for %%F in (admin\dist.zip backend-update.tar.gz sql.tar.gz) do (
  if exist %%F (
    for %%A in (%%F) do echo   ok       %%F  %%~zA bytes  %%~tA
  ) else (
    echo   [x] missing %%F
    set "MISSING=1"
  )
)
if defined MISSING goto :fail

tar -tzf backend-update.tar.gz | findstr /c:"backend/app/api/routes/ai.py" >nul 2>&1
if errorlevel 1 ( echo   [x] ai.py absent from backend package & goto :fail )
tar -tzf backend-update.tar.gz | findstr /c:"backend/app/api/routes/ai_admin.py" >nul 2>&1
if errorlevel 1 ( echo   [x] ai_admin.py absent from backend package & goto :fail )
tar -tzf backend-update.tar.gz | findstr /c:"backend/app/services/ai_chat_service.py" >nul 2>&1
if errorlevel 1 ( echo   [x] ai_chat_service.py absent from backend package & goto :fail )
tar -tzf backend-update.tar.gz | findstr /c:"backend/.env.prod" >nul 2>&1
if errorlevel 1 ( echo   [x] .env.prod absent from backend package & goto :fail )
echo   ok       backend package carries AI routes/services and .env.prod

set "LEAK="
for /f "delims=" %%E in ('tar -tzf backend-update.tar.gz') do if "%%E"=="backend/.env" set "LEAK=1"
if defined LEAK (
  echo   [x] local backend/.env leaked into the package - it holds dev secrets
  goto :fail
)
echo   ok       local backend/.env is NOT in the package

tar -tzf sql.tar.gz | findstr /c:"init/021_ai_center.sql" >nul 2>&1
if errorlevel 1 ( echo   [x] 021_ai_center.sql absent from sql package & goto :fail )
tar -tzf sql.tar.gz | findstr /c:"init/022_ai_admin_menus.sql" >nul 2>&1
if errorlevel 1 ( echo   [x] 022_ai_admin_menus.sql absent from sql package & goto :fail )
echo   ok       sql package carries migrations 021/022
echo.

echo ==========================================================
echo  BUILD OK - artifacts in %ROOT%
echo ==========================================================
echo  Server-side steps, in this order:
echo.
echo   1. upload sql.tar.gz, backend-update.tar.gz, admin\dist.zip
echo.
echo   2. migrations - extract sql.tar.gz over the repo checkout, then
echo        docker compose run --rm database-init
echo      it skips versions already in schema_migrations. Verify:
echo        SELECT version FROM schema_migrations ORDER BY version;
echo      must list 021_ai_center and 022_ai_admin_menus.
echo      Before DDL, make sure no idle-in-transaction session blocks it.
echo.
echo   3. backend - extract backend-update.tar.gz, then compare .env.prod
echo      against the live server copy: keep the server's real
echo      DATABASE_URL / JWT_SECRET / ADMIN_PASSWORD, do not overwrite them
echo      with repo placeholders. APP_ENV=prod comes from the service unit,
echo      not from .env. Restart the backend, then smoke test:
echo        curl -o /dev/null -w "%%{http_code}\n" https://swkjdj.sz-watech.com/api/ai/conversations
echo      expect 401. A 404 means the new code is not running.
echo.
echo   4. admin - unzip admin\dist.zip into the nginx web root
echo      (zip root already is index.html + assets/).
echo.
echo   5. mini program - WeChat DevTools Upload button, or its CLI:
echo        cli.bat upload --project "%ROOT%." -v VERSION -d "release note"
echo      No config edit is needed: trial/release always target
echo      https://swkjdj.sz-watech.com/api - see frontend\services\config.js.
echo      Do this only AFTER step 3 returns 401.
echo ==========================================================
exit /b 0

:fail
echo.
echo [x] release build failed
pause
exit /b 1
