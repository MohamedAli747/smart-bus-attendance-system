@echo off
echo Starting dev server using npm.cmd from Program Files...
"%ProgramFiles%\nodejs\npm.cmd" run dev
if %errorlevel% neq 0 (
  echo npm run dev failed with exit code %errorlevel%.
  pause
  exit /b %errorlevel%
)
