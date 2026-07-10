# Changelog

Tutte le modifiche rilevanti del progetto sono documentate in questo file.
Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
versionamento [SemVer](https://semver.org/lang/it/).

## [1.1.0] - 2026-07-11

### Aggiunto
- **Configurazione completa dalla UI** (⚙️ Impostazioni): AI, Discord, TikTok, audio, soglie, password, porta. Persistenza su `config.json` (precedenza su `.env`), applicazione a caldo: re-init bot Discord al cambio token, reload del modello Whisper senza riavvio, riavvio del server dal pannello
- **Rilevatori AI personalizzati** 🔔: condizioni in linguaggio naturale ("parlano di cucina", "nominano il criceto") verificate periodicamente da Claude sul contesto di ogni sorgente; notifiche browser + toast + eventi nel feed, cooldown configurabile
- **Interventi attivi del bot Discord** 🤖: criteri di intervento definiti dalla UI; al trigger il bot scrive in chat e/o **parla nel canale vocale** con voce neurale italiana (Edge TTS, 4 voci). Messaggio fisso o generato da Claude in base al contesto; test immediato dalla UI
- Endpoint `POST /tts` nel sidecar audio (Edge TTS) e `POST /reload` per cambio modello Whisper a caldo
- Test AI dal pannello impostazioni (latenza + verdetto di prova)
- Versione visibile nell'header della dashboard

### Modificato
- Il sidecar Whisper legge `config.json` (modello scelto dalla UI) con fallback su env
- Messaggi d'errore più chiari quando bot/AI non sono configurati

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
