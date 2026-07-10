# Changelog

Tutte le modifiche rilevanti del progetto sono documentate in questo file.
Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
versionamento [SemVer](https://semver.org/lang/it/).

## [1.0.0] - 2026-07-10

🚧 Prima release pubblica — Work in Progress.

### Aggiunto
- Monitoraggio chat live TikTok in tempo reale (tiktok-live-connector v2)
- Monitoraggio audio live TikTok: ffmpeg su HLS → chunk PCM → trascrizione Whisper
- Monitoraggio Discord: canali testuali + ricezione audio per-utente nei canali vocali
- Motore di scoring 0–100 con decadimento esponenziale (emivita 45 s)
- Dizionario italiano del barcello (~150 pattern pesati) + euristiche (CAPS, picchi chat, litigi 1v1)
- Rilevamento urla tramite RMS relativo al baseline della live
- Classificazione ibrida AI con Claude: provider `claude-sdk` (subscription) e `api`
- Dashboard web: gauge animato, feed eventi con evidenziazione keyword, timeline 10 min, allarme sonoro + notifiche browser
- Sidecar Whisper (faster-whisper, Flask, italiano, VAD)
- Basic Auth opzionale per deploy pubblici (`DASH_PASSWORD`)
- Log eventi JSONL giornaliero
- Script Windows (`install.bat`, `start.bat`)
- Tema dedicato a @cricetomannaro000 🐹
