@echo off
echo ============================================
echo  Kahl Route ^& Permit Intelligence System
echo ============================================
echo.
echo Starting Backend (FastAPI)...
start "Backend - FastAPI" cmd /k "cd /d %~dp0backend && pip install -r requirements.txt -q && uvicorn main:app --reload --port 8000"
timeout /t 3 /nobreak >nul
echo Starting Frontend (Next.js)...
start "Frontend - Next.js" cmd /k "cd /d %~dp0frontend && npm install && npm run dev"
echo.
echo ============================================
echo  Backend:  http://localhost:8000
echo  API-Docs: http://localhost:8000/docs
echo  Frontend: http://localhost:3000
echo ============================================
echo.
pause
