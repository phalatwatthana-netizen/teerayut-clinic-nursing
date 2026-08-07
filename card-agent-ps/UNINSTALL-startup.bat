@echo off
title Remove idcard-agent from Startup
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\idcard-agent.vbs"
if exist "%VBS%" ( del "%VBS%" & echo Removed from Startup. ) else ( echo Not found in Startup. )
echo (Note: the running agent stays until you close it or restart the PC.)
pause
