@echo off
title idcard-agent
echo Starting ID card agent... keep this window open.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0idcard-agent.ps1"
echo.
echo Agent stopped. Press any key to close.
pause >nul
