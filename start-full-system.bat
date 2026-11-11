@echo off
title TeethLink Dental Hospital System (localhost:4000)
cd /d "%~dp0"

REM Ensure Node.js is in PATH on this machine
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    set "PATH=C:\Users\xprenspel\AppData\Local\OpenAI\Codex\runtimes\cua_node\76f5b5935a63c7ba\bin;C:\Users\xprenspel\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;%PATH%"
)

echo ============================================================================
echo   TeethLink - Dental Hospital Queuing ^& Patient-Doctor Matching System
echo ============================================================================
echo   URL (GUI):        http://localhost:4000
echo   REST API Base:    http://localhost:4000/api/v1
echo   Health Check:     http://localhost:4000/api/v1/health
echo   Socket.io Live:   ws://localhost:4000/realtime
echo ----------------------------------------------------------------------------
echo   DEMO ACCOUNTS:
echo   - Admin:      +201000000001  ^|  Admin@12345
echo   - Supervisor: +201000000002  ^|  Supervisor@12345  (Dr. Hany Mahmoud)
echo   - Doctor 1:   +201000000101  ^|  Doctor@12345      (Dr. Omar Khaled)
echo   - Doctor 2:   +201000000102  ^|  Doctor@12345      (Dr. Nourhan Tarek)
echo   - Patient 1:  +201000000201  ^|  Patient@12345     (Sara Ahmed Hassan)
echo   - Patient 2:  +201000000202  ^|  Patient@12345     (Mahmoud Saeed)
echo   - Patient 3:  +201000000203  ^|  Patient@12345     (Fatma Ali Ibrahim)
echo   - Patient 4:  +201000000204  ^|  Patient@12345     (Youssef Adel Kamal)
echo ============================================================================
echo.

REM Open browser automatically after 3 seconds
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:4000"

REM Start the TeethLink server
node src/server.js
pause
