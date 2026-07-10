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
  AUDIO_ENABLED: true,
  AUDIO_CHUNK_SEC: 8,
  WHISPER_MODEL: 'small',
  WHISPER_URL: 'http://127.0.0.1:3901',
  // Rilevatori AI personalizzati: [{id, name, prompt, enabled}]
  WATCHERS: [],
  WATCHER_INTERVAL_SEC: 60,
  WATCHER_COOLDOWN_SEC: 300,
  // Interventi bot Discord: [{id, name, prompt, mode: chat|voice|both, reply, enabled}]
  INTERVENTIONS: [],
  INTERVENTION_COOLDOWN_SEC: 300,
  TTS_VOICE: 'it-IT-DiegoNeural',
};

// Chiavi il cui nuovo valore richiede riavvio del server
const RESTART_KEYS = ['PORT'];
// Chiavi segrete: mai inviate in chiaro alla UI
const SECRET_KEYS = ['DASH_PASSWORD', 'ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN', 'TIKTOK_SIGN_API_KEY'];
const NUMERIC_KEYS = ['PORT', 'AI_TRIGGER_SCORE', 'AI_COOLDOWN_SEC', 'ALERT_THRESHOLD', 'AUDIO_CHUNK_SEC', 'WATCHER_INTERVAL_SEC', 'WATCHER_COOLDOWN_SEC', 'INTERVENTION_COOLDOWN_SEC'];
const BOOL_KEYS = ['AUDIO_ENABLED'];
const JSON_KEYS = ['WATCHERS', 'INTERVENTIONS'];

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
