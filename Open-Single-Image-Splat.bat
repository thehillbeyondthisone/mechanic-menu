@echo off
rem Patterson single-image splat menu: starts the local server (desktop + Quest HTTPS) and opens the menu.
cd /d "%~dp0"
start "Patterson splat server" cmd /k python -B tools\serve.py
timeout /t 2 >nul
start "" http://127.0.0.1:8765/
