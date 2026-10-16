@echo off
setlocal
cd /d "%~dp0"

if not exist docker\init (
  echo [x] docker\init directory not found
  goto :fail
)

echo [1/3] checking SQL files under docker\init
dir /b /a-d docker\init\*.sql >nul 2>&1
if errorlevel 1 (
  echo [x] no *.sql found under docker\init
  goto :fail
)

echo [2/3] packaging docker\init into sql.tar.gz
if exist sql.tar.gz del /q sql.tar.gz
tar -czf sql.tar.gz -C docker init
if errorlevel 1 goto :fail

echo [3/3] verifying package
tar -tzf sql.tar.gz >nul 2>&1 || goto :fail
for /f "delims=" %%F in ('tar -tzf sql.tar.gz') do echo   %%F

echo.
echo done: %~dp0sql.tar.gz
exit /b 0

:fail
echo [x] packaging failed
pause
exit /b 1
