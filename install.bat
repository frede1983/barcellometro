@echo off
chcp 65001 >nul
cd /d %~dp0
echo ==========================================
echo    BARCELLOMETRO - Installazione
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRORE] Node.js non trovato. Installa Node 20+ : winget install OpenJS.NodeJS.LTS
  pause & exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -v') do set NODEMAJ=%%v
echo [OK] Node.js %NODEMAJ%

where python >nul 2>nul
if errorlevel 1 (
  echo [AVVISO] Python non trovato: l'analisi AUDIO non funzionera'. Installa con: winget install Python.Python.3.12
) else (
  echo [OK] Python trovato
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [AVVISO] ffmpeg non trovato: audio TikTok disattivato. Installa con: winget install Gyan.FFmpeg
) else (
  echo [OK] ffmpeg trovato
)

echo.
echo Installazione dipendenze Node.js...
call npm install
if errorlevel 1 (
  echo [ERRORE] npm install fallito
  pause & exit /b 1
)

where python >nul 2>nul
if not errorlevel 1 (
  echo.
  echo Installazione dipendenze Python (faster-whisper)...
  pip install -r whisper\requirements.txt
)

if not exist .env (
  copy .env.example .env >nul
  echo.
  echo [!] Creato file .env - aprilo e inserisci le tue chiavi (Discord bot, Anthropic API)
)

echo.
echo ==========================================
echo  Installazione completata!
echo  1. Configura il file .env
echo  2. Lancia start.bat
echo ==========================================
pause
