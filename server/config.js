/**
 * BARCELLOMETRO - Configurazione runtime
 * Base: variabili d'ambiente (.env). Overlay: config.json (modificabile dalla UI).
 * config.json vince sempre su .env. I segreti non compaiono mai in chiaro nella UI.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Chiavi gestibili dalla UI, con default
const DEFAULTS = {
  PORT: 3900,
  DASH_PASSWORD: '',
  AI_PROVIDER: 'claude-sdk',      // claude-sdk | api | off
  AI_MODEL: '',                    // vuoto = default del provider
  ANTHROPIC_API_KEY: '',
  AI_TRIGGER_SCORE: 40,
  AI_COOLDOWN_SEC: 90,
  ALERT_THRESHOLD: 70,
  DISCORD_BOT_TOKEN: '',
  TIKTOK_SIGN_API_KEY: '',
  TIKTOK_SESSION_ID: '',
  AUDIO_ENABLED: true,
  AUDIO_CHUNK_SEC: 8,
  WHISPER_MODEL: 'small',
  WHISPER_URL: 'http://127.0.0.1:3901',
  // Lingue rilevamento keyword (csv: it,en,es) e lingua trascrizione audio
  DETECT_LANGS: 'it,en,es',
  AUDIO_LANG: 'it',
  UI_LANG: 'it',
  // Notifiche esterne
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  HA_URL: '',
  HA_TOKEN: '',
  HA_MEDIA_PLAYER: '',
  HA_TTS_ENTITY: '',
  NOTIFY_ON_ALERT: true,
  NOTIFY_ON_MODERATION: false,
  NOTIFY_ON_CROSSHOST: true,
  // Clip automatiche di picco
  CLIPS_ENABLED: true,
  // Rilevatori AI personalizzati: [{id, name, prompt, enabled}]
  WATCHERS: [],
  WATCHER_INTERVAL_SEC: 60,
  WATCHER_COOLDOWN_SEC: 300,
  // Interventi bot Discord: [{id, name, prompt, mode: chat|voice|both, reply, enabled}]
  INTERVENTIONS: [],
  INTERVENTION_COOLDOWN_SEC: 300,
  TTS_VOICE: 'it-IT-DiegoNeural',
  // Pesi punti PUTT (fedeltà community): punti assegnati per azione
  PUTT_WEIGHTS: {
    donation: 1.0,   // per diamante donato
    share: 15,       // per condivisione della live
    follow: 25,      // per nuovo follow
    like: 0.02,      // per like/taptap (numeri alti: peso basso)
    chat: 0.3,       // per messaggio in chat
    audio: 0.8,      // per intervento vocale
    visit: 8,        // per presenza/ritorno all'host
    loyaltyBonusPct: 15, // % bonus se fedele a un solo host (>70% punti)
  },
  // Moderazione AI Discord: regolamento scritto dall'utente, applicato da Claude
  MODERATION: {
    enabled: false,
    rules: '',
    actions: { warn: true, voice: false, delete: true, timeout: true, kick: false, ban: false },
    maxTimeoutMin: 10,
    intervalSec: 45,
    userCooldownSec: 180,
  },
};

// Chiavi il cui nuovo valore richiede riavvio del server
const RESTART_KEYS = ['PORT'];
// Chiavi segrete: mai inviate in chiaro alla UI
const SECRET_KEYS = ['DASH_PASSWORD', 'ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN', 'TIKTOK_SIGN_API_KEY', 'TIKTOK_SESSION_ID'];
const NUMERIC_KEYS = ['PORT', 'AI_TRIGGER_SCORE', 'AI_COOLDOWN_SEC', 'ALERT_THRESHOLD', 'AUDIO_CHUNK_SEC', 'WATCHER_INTERVAL_SEC', 'WATCHER_COOLDOWN_SEC', 'INTERVENTION_COOLDOWN_SEC'];
const BOOL_KEYS = ['AUDIO_ENABLED'];
const JSON_KEYS = ['WATCHERS', 'INTERVENTIONS', 'MODERATION', 'PUTT_WEIGHTS'];

/** Sanifica la lista watcher */
function sanitizeWatchers(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 20).map(w => ({
    id: String(w.id || `w${Date.now()}${Math.floor(Math.random() * 1000)}`).slice(0, 32),
    name: String(w.name || '').trim().slice(0, 40) || 'Senza nome',
    prompt: String(w.prompt || '').trim().slice(0, 300),
    enabled: w.enabled !== false,
  })).filter(w => w.prompt);
}

/** Sanifica la configurazione moderazione */
function sanitizeModeration(m) {
  if (!m || typeof m !== 'object') return undefined;
  const a = m.actions || {};
  return {
    enabled: Boolean(m.enabled),
    rules: String(m.rules || '').slice(0, 4000),
    actions: {
      warn: a.warn !== false,
      voice: Boolean(a.voice),
      delete: a.delete !== false,
      timeout: a.timeout !== false,
      kick: Boolean(a.kick),
      ban: Boolean(a.ban),
    },
    maxTimeoutMin: Math.max(1, Math.min(1440, Number(m.maxTimeoutMin) || 10)),
    intervalSec: Math.max(20, Math.min(600, Number(m.intervalSec) || 45)),
    userCooldownSec: Math.max(30, Math.min(3600, Number(m.userCooldownSec) || 180)),
  };
}

/** Sanifica i pesi putt (numeri >= 0) */
function sanitizePuttWeights(w) {
  if (!w || typeof w !== 'object') return undefined;
  const keys = ['donation', 'share', 'follow', 'like', 'chat', 'audio', 'visit', 'loyaltyBonusPct'];
  const out = {};
  for (const k of keys) {
    const n = Number(w[k]);
    out[k] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS.PUTT_WEIGHTS[k];
  }
  return out;
}

/** Sanifica la lista interventi bot */
function sanitizeInterventions(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, 20).map(w => ({
    id: String(w.id || `i${Date.now()}${Math.floor(Math.random() * 1000)}`).slice(0, 32),
    name: String(w.name || '').trim().slice(0, 40) || 'Intervento',
    prompt: String(w.prompt || '').trim().slice(0, 300),
    mode: ['chat', 'voice', 'both'].includes(w.mode) ? w.mode : 'chat',
    reply: String(w.reply || '').trim().slice(0, 250),
    enabled: w.enabled !== false,
  })).filter(w => w.prompt);
}

let overlay = {};
try {
  overlay = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch { overlay = {}; }

function coerce(key, val) {
  if (val === undefined || val === null) return undefined;
  if (BOOL_KEYS.includes(key)) return String(val) === 'true' || val === true;
  if (NUMERIC_KEYS.includes(key)) {
    const n = Number(val);
    return Number.isFinite(n) ? n : undefined;
  }
  if (JSON_KEYS.includes(key)) {
    let v = val;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return undefined; } }
    if (key === 'WATCHERS') return sanitizeWatchers(v);
    if (key === 'INTERVENTIONS') return sanitizeInterventions(v);
    if (key === 'MODERATION') return sanitizeModeration(v);
    if (key === 'PUTT_WEIGHTS') return sanitizePuttWeights(v);
    return v;
  }
  return String(val);
}

/** Valore effettivo: config.json > .env > default */
function get(key) {
  if (overlay[key] !== undefined) return coerce(key, overlay[key]);
  if (process.env[key] !== undefined && process.env[key] !== '') return coerce(key, process.env[key]);
  return DEFAULTS[key];
}

/** Snapshot completo (segreti in chiaro: solo per uso interno) */
function all() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = get(k);
  return out;
}

/** Snapshot per la UI: segreti mascherati come {set: true/false} */
function forUI() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (SECRET_KEYS.includes(k)) {
      const v = get(k);
      out[k] = { secret: true, set: Boolean(v), hint: v ? `••••${String(v).slice(-4)}` : '' };
    } else {
      out[k] = get(k);
    }
  }
  return out;
}

/**
 * Applica una patch dalla UI e persiste su config.json.
 * Regole segreti: stringa vuota = non cambiare; "-" = cancella.
 * Ritorna { changed: [chiavi], needsRestart: [chiavi] }
 */
function save(patch) {
  const changed = [];
  for (const [k, raw] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    let val = raw;
    if (SECRET_KEYS.includes(k)) {
      if (val === '' || val === undefined || val === null) continue; // non cambiare
      if (val === '-') val = '';                                     // cancella
    }
    const coerced = coerce(k, val);
    if (coerced === undefined) continue;
    if (JSON.stringify(get(k)) === JSON.stringify(coerced)) continue;
    overlay[k] = coerced;
    changed.push(k);
  }
  if (changed.length) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(overlay, null, 2));
  }
  return {
    changed,
    needsRestart: changed.filter(k => RESTART_KEYS.includes(k)),
  };
}

module.exports = { get, all, forUI, save, SECRET_KEYS, RESTART_KEYS, CONFIG_PATH };
