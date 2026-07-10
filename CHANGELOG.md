# Changelog

Tutte le modifiche rilevanti del progetto sono documentate in questo file.
Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.1.0/),
versionamento [SemVer](https://semver.org/lang/it/).

## [1.4.0] - 2026-07-11

### Aggiunto — Bridge TikTok 🌉
- **Bridge locale + hub sul server**: risolve il blocco della firma TikTok dagli IP datacenter. Un piccolo script (`bridge/`) gira sul PC di casa (IP residenziale, dove la firma anonima passa), si collega al Barcellometro sul VPS via WebSocket con token e **inoltra tutti gli eventi** (chat, regali, share/follow/like, match, viewers, stream URL)
- **RemoteTikTokSource**: quando il bridge è connesso, le nuove sorgenti TikTok passano automaticamente da esso; l'audio viene elaborato sul server usando lo stream URL inoltrato
- Endpoint `/bridge` autenticato a token (separato dalla Basic Auth della dashboard); comandi start/stop automatici e riconnessione
- Stato bridge nell'header (🌉) e badge "bridge" sulle sorgenti relative
- Script pronto: `bridge/avvia-bridge.bat` (Windows) + `bridge/.env`
- Impostazioni: token bridge e modalità "solo bridge"

## [1.3.1] - 2026-07-11

### Corretto / Migliorato
- Connessione TikTok allineata al setup anonimo funzionante (rif. TokScope): `processInitialData`, `requestPollingIntervalMs`, `enableExtendedGiftInfo` attivo solo con sessionId, versione connector fissata a 2.1.0
- Supporto **Session ID TikTok** (cookie `sessionid`) configurabile dalla UI: sblocca live ristrette e riduce i rate-limit
- Nota importante: la firma anonima Euler è concessa dagli **IP residenziali**; dagli **IP datacenter (VPS)** può servire chiave/sessionId o piano a pagamento (causa dell'errore "Business plan"). Per il TikTok conviene eseguire dal PC di casa.

## [1.3.0] - 2026-07-11

🚧 Work in Progress. Completata la roadmap principale.

### Aggiunto
- **📈 Storico barcelli con replay**: campionamento continuo dello score (globale e per sorgente), persistito su JSONL, con endpoint per il replay della timeline
- **🎬 Clip automatiche dei picchi**: al superamento soglia il sistema cattura una clip-highlight (chat + trascrizioni + score del momento), consultabile e scaricabile dalla tab Clip
- **🔔 Notifiche esterne Telegram e Home Assistant**: avvisi su barcello, moderazione e cross-host; TTS via HA (tts.speak) o persistent_notification; test dalla UI
- **🌍 Multi-lingua**: dizionari barcello in italiano, inglese e spagnolo con lingue di rilevamento selezionabili; lingua di trascrizione audio (Whisper) configurabile
- **👑 Punti putt configurabili**: sezione dedicata per assegnare il punteggio a ogni azione (donazione, condivisione, follow, taptap/like, chat, vocale, presenza) + bonus fedeltà; ricalcolo immediato della classifica
- **Eventi social TikTok**: condivisioni, follow e like (taptap) alimentano i punti putt

### Note
- Rilevamento barcello nei match TikTok (linkMicBattle) già introdotto in v1.2 con aggancio avversario e flag ping-pong

## [1.2.0] - 2026-07-11

🚧 Work in Progress.

### Aggiunto
- **🛡️ Moderazione AI Discord**: scrivi il regolamento e le conseguenze in linguaggio naturale; l'AI legge chat e vocale e applica le sanzioni consentite (avviso, avviso vocale, cancellazione messaggio, timeout, kick, ban) con permessi Discord reali, cooldown per utente e timeout massimo configurabile
- **📜 Registro attività Discord** persistente (JSONL): chat, parlato trascritto, entrate/uscite dai canali vocali, azioni bot e moderazione — consultabile e filtrabile dalla UI
- **👥 Schede profilo** per ogni persona vista (TikTok e Discord) con avatar, primo/ultimo avvistamento, statistiche, cronologia messaggi/audio, host frequentati, donazioni e violazioni subite
- **⚔️ Match TikTok**: al rilevamento di un match il sistema aggancia automaticamente la live dell'avversario e ne mostra la chat; gli utenti che commentano **avanti e indietro** tra le due chat vengono flaggati (🔀) con boost di score
- **👁️ Rubrica persone monitorate** con tracking **cross-host**: avviso quando un utente in rubrica compare in una live/server e allerta speciale se va **da un altro host**
- **🎁 Donazioni TikTok**: rilevamento gift con valore in diamanti, contatore donazioni per live e totale
- **👑 Classifica "putt"**: punti fedeltà della community calcolati su donazioni, presenza ripetuta e attività, con bonus a chi è fedele a un singolo host
- Voce del bot in vocale via Edge TTS

### Note
- Le azioni kick/ban richiedono che il bot abbia i relativi permessi e un ruolo più alto del bersaglio

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
