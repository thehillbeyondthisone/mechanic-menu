@echo off
cd /d "%~dp0"
echo Private demo on Harbinger. Keep this window open while using the demo.
echo Desktop: open the URL printed below. Normally port 8840; a free port is selected if it is busy.
echo Close this window or press Ctrl+C to stop.
node scripts/serve.mjs
pause
