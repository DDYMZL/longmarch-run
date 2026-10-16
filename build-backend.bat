@echo off
setlocal
cd /d "%~dp0"

if not exist backend (
  echo [x] backend directory not found
  goto :fail
)

echo [1/2] packaging backend into backend-update.tar.gz
if exist backend-update.tar.gz del /q backend-update.tar.gz
tar -czf backend-update.tar.gz ^
  --exclude=.venv ^
  --exclude=__pycache__ ^
  --exclude=test ^
  --exclude=.env ^
  --exclude=*.db ^
  --exclude=_smoke_*.py ^
  --exclude=_inspect_db.py ^
  --exclude=*results*.json ^
  backend
if errorlevel 1 goto :fail

echo [2/2] verifying package
tar -tzf backend-update.tar.gz >nul 2>&1 || goto :fail
tar -tzf backend-update.tar.gz | findstr /e /c:".env" /c:".db" >nul 2>&1
if not errorlevel 1 (
  echo [x] package contains .env or *.db, aborted
  del /q backend-update.tar.gz
  goto :fail
)
tar -tzf backend-update.tar.gz | findstr /c:"backend/test/" >nul 2>&1
if not errorlevel 1 (
  echo [x] package contains backend/test, aborted
  del /q backend-update.tar.gz
  goto :fail
)

echo.
echo done: %~dp0backend-update.tar.gz
exit /b 0

:fail
echo [x] packaging failed
pause
exit /b 1
