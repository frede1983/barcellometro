@echo off
chcp 65001 >nul
cd /d %~dp0
echo ==========================================
echo    BARCELLOMETRO - Bridge TikTok (locale)
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRORE] Node.js non trovato. Installa Node 20+ : winget install OpenJS.NodeJS.LTS
  pause & exit /b 1
)

if not exist node_modules (
  echo Installazione dipendenze...
  call npm install
)

if not exist .env (
  copy .env.example .env >nul
  echo.
  echo [!] Creato .env - aprilo e inserisci BARCELLO_URL e BRIDGE_TOKEN, poi rilancia.
  notepad .env
  pause & exit /b 0
)

echo Avvio bridge... (CTRL+C per uscire)
echo.
node tiktok-bridge.js
pause
