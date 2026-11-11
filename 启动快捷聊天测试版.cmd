@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto failed
if not exist "%~dp0node_modules\electron\dist\electron.exe" goto missing_runtime
set "ELECTRON_RUN_AS_NODE="
set "TEMP=%~dp0artifacts\quick-chat-tests\temp"
set "TMP=%TEMP%"
set "HF_HUB_OFFLINE=1"
set "TRANSFORMERS_OFFLINE=1"
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%TEMP%" goto failed
if /i "%~1"=="--check" goto checked
echo Starting the local quick-chat preview with existing models and voice resources.
echo If another pet is running, exit it from the tray before starting this preview.
echo Shortcut: Ctrl+Alt+E. Press Esc to hide the input bar.
start "" /D "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --local-preview --show-quick-chat
if errorlevel 1 goto failed
exit /b 0

:checked
echo Preview launcher check passed. The existing Electron runtime is available.
echo No app or model has been started. No resources have been downloaded.
exit /b 0

:missing_runtime
echo The existing Electron runtime is missing from this project.
echo This launcher does not download or install anything.
if /i "%~1"=="--check" exit /b 1
pause
exit /b 1

:failed
echo The preview could not start. Check the project path and folder permissions.
if /i "%~1"=="--check" exit /b 1
pause
exit /b 1
