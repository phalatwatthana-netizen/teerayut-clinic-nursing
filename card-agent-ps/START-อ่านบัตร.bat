@echo off
chcp 65001 >nul
title idcard-agent - อ่านบัตรประชาชน
echo กำลังเปิดโปรแกรมอ่านบัตร... (เปิดหน้าต่างนี้ค้างไว้)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0idcard-agent.ps1"
echo.
echo โปรแกรมหยุดทำงาน — กดปุ่มใดก็ได้เพื่อปิด
pause >nul
