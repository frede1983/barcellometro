@echo off
chcp 65001 >nul
cd /d %~dp0

if not exist .env copy .env.example .env >nul

rem --- Carica variabili dal file .env ---
set PORT=3900
set WHISPER_PORT=3901
set WHISPER_MODEL=small
set AUDIO_ENABLED=true
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
  if not "%%b"=="" set "%%a=%%b"
)

rem --- Avvia il sidecar Whisper (audio) in una finestra separata ---
if /i "%AUDIO_ENABLED%"=="true" (
  where python >nul 2>nul
  if not errorlevel 1 (
    start "Barcellometro - Whisper (audio)" cmd /k "cd /d %~dp0whisper && python server.py"
  ) else (
    echo [AVVISO] Python non trovato: modalita' solo chat
  )
)

rem --- Apri la dashboard nel browser ---
timeout /t 2 >nul
start "" http://localhost:%PORT%

rem --- Avvia il server principale ---
echo.
echo   BARCELLOMETRO in avvio su http://localhost:%PORT%
echo   (CTRL+C per uscire)
echo.
node server\index.js
pause
