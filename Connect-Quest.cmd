@echo off
rem Connect the USB-attached, developer-mode Quest to the demo running on this PC (Start-Office.cmd).
rem Uses the existing adb from the Gaussian Splat tooling. Traffic stays on the USB cable; nothing is
rem installed, uploaded or changed on the headset. Run again after re-plugging or waking the headset.
setlocal
set "ADB=C:\Users\thefo\OneDrive\Desktop\Gaussian Splat\.tooling\android-sdk\platform-tools\adb.exe"
set "PORT=8840"
if not "%~1"=="" set "PORT=%~1"
if not exist "%ADB%" (echo adb not found at "%ADB%" & pause & exit /b 1)
"%ADB%" start-server >nul 2>&1
for /f "skip=1 tokens=1,2" %%a in ('"%ADB%" devices') do if "%%b"=="device" set "SERIAL=%%a"
if not defined SERIAL (
  echo No authorized headset found. Plug in the Quest, put it on, and accept "Allow USB debugging".
  pause & exit /b 1
)
echo Headset %SERIAL%: forwarding localhost:%PORT% over USB...
"%ADB%" -s %SERIAL% reverse tcp:%PORT% tcp:%PORT% || (pause & exit /b 1)
"%ADB%" -s %SERIAL% shell am start -a android.intent.action.VIEW -d http://localhost:%PORT%/ -p com.oculus.browser >nul
echo Opened http://localhost:%PORT%/ in Quest Browser. Press Enter VR in the headset.
timeout /t 5 >nul
