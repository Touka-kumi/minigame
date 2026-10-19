@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not defined PORT set "PORT=3000"
set "NODE_EXE=node"
if defined SNOW_NODE set "NODE_EXE=%SNOW_NODE%"
if not defined SNOW_NODE if exist "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

echo.
echo Starting Snow Bet Lab at http://localhost:%PORT%
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%"
"%NODE_EXE%" server.js
echo.
echo Server stopped.
pause
