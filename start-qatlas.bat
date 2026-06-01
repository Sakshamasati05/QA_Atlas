@echo off
title QAtlas AI Assistant Launcher
echo ===================================================
echo   LAUNCHING QATLAS PERSISTENT AI ASSISTANT         
echo ===================================================
echo.

cd /d "C:\Users\saksham.asati\.gemini\antigravity\scratch"

echo [1/2] Starting QAtlas SQLite Backend (Port 5000)...
start "QAtlas Backend" cmd /c "cd workflow-backend && node server.js"
timeout /t 3 /nobreak > nul

echo [2/2] Starting QAtlas React Frontend (Port 5173)...
start "QAtlas Frontend" cmd /c "cd ai-assistant && npm run dev"

echo.
echo ===================================================
echo   SYSTEM LAUNCHED SUCCESSFULLY!
echo ===================================================
echo   - Backend API:  http://localhost:5000/api
echo   - Frontend App: http://localhost:5173/
echo ===================================================
pause
