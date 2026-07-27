@echo off
echo Installing dependencies using npm.cmd from Program Files...
"%ProgramFiles%\nodejs\npm.cmd" install
if %errorlevel% neq 0 (
  echo npm install failed with exit code %errorlevel%.
  pause
  exit /b %errorlevel%
)
echo Done.
pause
