@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing project dependencies...
  call npm.cmd install
  if errorlevel 1 pause & exit /b 1
)
call npm.cmd run desktop:widget
if errorlevel 1 pause
