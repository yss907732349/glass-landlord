@echo off
setlocal
cd /d "%~dp0"
if exist "release\GlassLandlord-0.2.3-Windows.exe" (
  start "" "release\GlassLandlord-0.2.3-Windows.exe"
  exit /b 0
)
echo Please open the Windows EXE from the release folder.
pause
