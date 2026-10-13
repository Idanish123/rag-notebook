@echo off
setlocal
cd /d "%~dp0backend"
if not exist ".venv\Scripts\python.exe" (
    echo Backend virtual environment is missing.
    echo Create it here with: py -3.13 -m venv .venv
    echo Then install: .venv\Scripts\python.exe -m pip install -r requirements-observability.txt
    exit /b 1
)
".venv\Scripts\python.exe" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
exit /b %errorlevel%
