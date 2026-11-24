@echo off
setlocal
cd /d "%~dp0"
if exist "release\GlassLandlord-0.1.0-Windows.exe" (
  start "" "release\GlassLandlord-0.1.0-Windows.exe"
  exit /b 0
)
echo Please open the Windows EXE from the release folder.
pause
