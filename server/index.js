/**
 * BARCELLOMETRO - Server principale
 * Express + WebSocket. Orchestra sorgenti (TikTok/Discord), scoring, AI, allarmi.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { ScoreEngine, levelFor } = require('./scoring');
const { AIClassifier } = require('./ai');
const { WhisperClient } = require('./audio/whisperClient');
const { TikTokSource } = require('./sources/tiktok');
const { initDiscord, isDiscordReady, listGuilds, DiscordSource } = require('./sources/discordSource');

const PORT = Number(process.env.PORT || 3900);
const AUDIO_ENABLED = String(process.env.AUDIO_ENABLED || 'true') === 'true';
const CHUNK_SEC = Number(process.env.AUDIO_CHUNK_SEC || 8);
const ALERT_THRESHOLD = 70;

const app = express();
app.use(express.json());

// --- Basic Auth (per deploy pubblico su VPS: imposta DASH_PASSWORD nel .env) ---
const DASH_PASSWORD = process.env.DASH_PASSWORD || '';
function checkAuth(headerValue) {
  if (!DASH_PASSWORD) return true;
  if (!headerValue || !headerValue.startsWith('Basic ')) return false;
  const decoded = Buffer.from(headerValue.slice(6), 'base64').toString();
  return decoded === `barcello:${DASH_PASSWORD}`;
}
if (DASH_PASSWORD) {
  app.use((req, res, next) => {
    if (checkAuth(req.headers.authorization)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Barcellometro"');
    res.status(401).send('Autenticazione richiesta');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info) => checkAuth(info.req.headers.authorization),
});

const whisper = new WhisperClient(process.env.WHISPER_URL);
const ai = new AIClassifier({
  provider: process.env.AI_PROVIDER || undefined,
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.AI_MODEL || undefined,
  triggerScore: Number(process.env.AI_TRIGGER_SCORE || 40),
  cooldownSec: Number(process.env.AI_COOLDOWN_SEC || 90),
});

/** sources: id -> { id, platform, name, engine, impl, viewers, audioActive, startedAt } */
const sources = new Map();
let nextId = 1;
let prevGlobal = 0;
let lastAlertAt = 0;

// ---------- Logging JSONL ----------
const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
function logEvent(obj) {
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFile(path.join(LOG_DIR, `eventi-${day}.jsonl`), JSON.stringify(obj) + '\n', () => {});
}

// ---------- WebSocket ----------
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(msg);
  }
}

function snapshot() {
  return {
    sources: [...sources.values()].map(s => ({
      id: s.id, platform: s.platform, name: s.name,
      score: s.engine.score, level: levelFor(s.engine.score),
      viewers: s.viewers, audioActive: Boolean(s.impl.audioActive || s.audioActive),
      startedAt: s.startedAt,
    })),
    global: globalScore(),
    whisper: { available: whisper.available, model: whisper.model },
    ai: { enabled: ai.enabled, model: ai.enabled ? ai.model : null },
    discordReady: isDiscordReady(),
  };
}

function globalScore() {
  let max = 0;
  for (const s of sources.values()) max = Math.max(max, s.engine.score);
  return max;
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', ...snapshot() }));
});

// ---------- Eventi dalle sorgenti ----------
function emitEvent(src, kind, user, text, result) {
  const ev = {
    ts: Date.now(), sourceId: src.id, sourceName: src.name, platform: src.platform,
    kind, user, text,
    points: result?.points || 0,
    matches: (result?.matches || []).map(m => m.kw),
    notes: result?.notes || [],
  };
  broadcast('event', { event: ev });
  if (ev.points > 0 || kind === 'ai' || kind === 'system') logEvent(ev);
}

function makeCallbacks(getSrc) {
  return {
    onChat: (user, text, channel) => {
      const src = getSrc();
      if (!src) return;
      const res = src.engine.addChat(user, text);
      if (res) emitEvent(src, 'chat', channel ? `${user} ${channel}` : user, text, res);
      maybeAI(src);
    },
    onTranscript: (speaker, text, shouted) => {
      const src = getSrc();
      if (!src) return;
      const res = src.engine.addTranscript(speaker, text, shouted);
      emitEvent(src, 'audio', speaker, text, res || { points: 0, matches: [], notes: shouted ? ['TONI ALTI'] : [] });
      maybeAI(src);
    },
    onSystem: (msg) => {
      const src = getSrc();
      if (src) emitEvent(src, 'system', 'sistema', msg, null);
    },
    onViewers: (n) => {
      const src = getSrc();
      if (src) src.viewers = n;
    },
    onEnd: () => {
      const src = getSrc();
      if (src) removeSource(src.id, 'live terminata');
    },
  };
}

async function maybeAI(src) {
  if (!ai.shouldClassify(src.engine)) return;
  const verdict = await ai.classify(src.engine, `${src.platform}:${src.name}`);
  if (!verdict) return;
  src.engine.blendAI(verdict);
  const txt = verdict.barcello
    ? `BARCELLO CONFERMATO (${verdict.intensita}/100)${verdict.protagonisti.length ? ' - ' + verdict.protagonisti.join(' vs ') : ''}: ${verdict.sintesi}`
    : `Falso allarme: ${verdict.sintesi}`;
  emitEvent(src, 'ai', 'Claude', txt, { points: verdict.barcello ? verdict.intensita : 0, matches: [], notes: [] });
}

// ---------- Gestione sorgenti ----------
async function addTikTok(username) {
  const id = `tt${nextId++}`;
  const src = {
    id, platform: 'tiktok', name: `@${username.replace(/^@/, '')}`,
    engine: new ScoreEngine(id), viewers: null, audioActive: false, startedAt: Date.now(),
    impl: null,
  };
  const cb = makeCallbacks(() => sources.get(id));
  src.impl = new TikTokSource(username, {
    signApiKey: process.env.TIKTOK_SIGN_API_KEY || undefined,
    audioEnabled: AUDIO_ENABLED,
    chunkSec: CHUNK_SEC,
    whisper,
    ...cb,
  });
  sources.set(id, src);
  try {
    await src.impl.start();
  } catch (err) {
    sources.delete(id);
    throw new Error(friendlyTikTokError(err));
  }
  broadcast('snapshot', snapshot());
  return src;
}

function friendlyTikTokError(err) {
  const m = String(err?.message || err);
  if (/offline|not.*live|UserOffline/i.test(m)) return 'L’utente non e’ in live adesso';
  if (/not.*found|user.*exist/i.test(m)) return 'Username TikTok non trovato';
  if (/rate|429|limit/i.test(m)) return 'Rate limit del sign server: riprova tra qualche minuto (o aggiungi TIKTOK_SIGN_API_KEY)';
  return m.slice(0, 200);
}

async function addDiscord({ guildId, textChannelIds, voiceChannelId }) {
  if (!isDiscordReady()) throw new Error('Bot Discord non configurato: aggiungi DISCORD_BOT_TOKEN nel file .env');
  const id = `dc${nextId++}`;
  const guilds = listGuilds();
  const g = guilds.find(x => x.id === guildId);
  if (!g) throw new Error('Server non trovato');
  const src = {
    id, platform: 'discord', name: g.name,
    engine: new ScoreEngine(id), viewers: null,
    audioActive: Boolean(voiceChannelId), startedAt: Date.now(),
    impl: null,
  };
  const cb = makeCallbacks(() => sources.get(id));
  src.impl = new DiscordSource({
    guildId, textChannelIds: textChannelIds || [], voiceChannelId: voiceChannelId || null,
    whisper, ...cb,
  });
  sources.set(id, src);
  try {
    await src.impl.start();
  } catch (err) {
    sources.delete(id);
    throw err;
  }
  broadcast('snapshot', snapshot());
  return src;
}

function removeSource(id, reason) {
  const src = sources.get(id);
  if (!src) return false;
  try { src.impl.stop(); } catch { /* ignore */ }
  sources.delete(id);
  broadcast('snapshot', snapshot());
  if (reason) broadcast('event', {
    event: { ts: Date.now(), sourceId: id, sourceName: src.name, platform: src.platform, kind: 'system', user: 'sistema', text: `Sorgente rimossa (${reason})`, points: 0, matches: [], notes: [] },
  });
  return true;
}

// ---------- API ----------
app.get('/api/state', (req, res) => res.json(snapshot()));

app.post('/api/sources/tiktok', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'username mancante' });
  if ([...sources.values()].some(s => s.platform === 'tiktok' && s.name === `@${username.replace(/^@/, '')}`)) {
    return res.status(409).json({ error: 'Gia’ in monitoraggio' });
  }
  try {
    const src = await addTikTok(username);
    res.json({ ok: true, id: src.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sources/discord', async (req, res) => {
  try {
    const src = await addDiscord(req.body || {});
    res.json({ ok: true, id: src.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sources/:id', (req, res) => {
  const ok = removeSource(req.params.id, 'rimossa dall’utente');
  res.json({ ok });
});

app.get('/api/discord/guilds', (req, res) => {
  if (!isDiscordReady()) return res.json({ ready: false, guilds: [] });
  res.json({ ready: true, guilds: listGuilds() });
});

// ---------- Tick: score, allarmi, health ----------
setInterval(() => {
  if (sources.size === 0 && wss.clients.size === 0) return;
  const scores = [...sources.values()].map(s => ({
    id: s.id, score: s.engine.score, level: levelFor(s.engine.score), viewers: s.viewers,
    audioActive: Boolean(s.impl?.audioActive || s.audioActive),
  }));
  const global = globalScore();
  broadcast('scores', { scores, global, globalLevel: levelFor(global) });

  const now = Date.now();
  if (global >= ALERT_THRESHOLD && prevGlobal < ALERT_THRESHOLD && now - lastAlertAt > 60000) {
    lastAlertAt = now;
    const top = [...sources.values()].sort((a, b) => b.engine.score - a.engine.score)[0];
    broadcast('alert', { global, sourceName: top ? top.name : '?', platform: top ? top.platform : '?' });
    logEvent({ ts: now, kind: 'ALERT', global, source: top?.name });
  }
  prevGlobal = global;
}, 1000);

setInterval(() => { whisper.checkHealth(); }, 30000);

// ---------- Avvio ----------
(async () => {
  console.log('===========================================');
  console.log('   BARCELLOMETRO v1.0');
  console.log('===========================================');

  await whisper.checkHealth();
  console.log(`[audio] Whisper: ${whisper.available ? `ATTIVO (modello ${whisper.model})` : 'NON DISPONIBILE (solo chat) - avvia whisper/server.py'}`);
  await ai.checkCli();
  const aiStatus = ai.enabled
    ? `ATTIVO via ${ai.provider === 'claude-sdk' ? 'Claude SDK/subscription' : 'Anthropic API'} (${ai.model})`
    : (ai.provider === 'claude-sdk' ? 'SPENTO (CLI claude non trovata/loggata)' : 'SPENTO (nessuna ANTHROPIC_API_KEY)');
  console.log(`[ai] Classificatore Claude: ${aiStatus}`);
  if (DASH_PASSWORD) console.log('[auth] Basic Auth attiva (utente: barcello)');

  if (process.env.DISCORD_BOT_TOKEN) {
    try {
      await initDiscord(process.env.DISCORD_BOT_TOKEN);
    } catch (err) {
      console.error('[discord] login fallito:', err.message);
    }
  } else {
    console.log('[discord] Nessun DISCORD_BOT_TOKEN: monitoraggio Discord disattivato');
  }

  server.listen(PORT, () => {
    console.log(`\n>>> Dashboard: http://localhost:${PORT}\n`);
  });
})();

process.on('SIGINT', () => {
  console.log('\nChiusura...');
  for (const id of [...sources.keys()]) removeSource(id);
  process.exit(0);
});
