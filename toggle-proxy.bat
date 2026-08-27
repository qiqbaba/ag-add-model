@echo off
chcp 65001 >nul
title Antigravity 代理一键开关
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0toggle-proxy.ps1"
echo.
pause
