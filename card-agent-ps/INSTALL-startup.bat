@echo off
title Install idcard-agent to Startup
setlocal
set "PS=%~dp0idcard-agent.ps1"
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\idcard-agent.vbs"

> "%VBS%" echo Set sh = CreateObject("WScript.Shell")
>> "%VBS%" echo sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""%PS%""", 0, False

echo ===================================================
echo  Installed to Windows Startup.
echo  The card agent will start automatically (hidden)
echo  every time you log in - no need to run it manually.
echo ===================================================
echo  Starting the agent now (hidden window)...
wscript "%VBS%"
echo  Done. You can close this window.
pause
