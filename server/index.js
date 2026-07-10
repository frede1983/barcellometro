/**
 * BARCELLOMETRO - Server principale
 * Express + WebSocket. Orchestra sorgenti (TikTok/Discord), scoring, AI,
 * rilevatori personalizzati, allarmi. Tutto configurabile dalla UI.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const cfg = require('./config');
const { ScoreEngine, levelFor } = require('./scoring');
const { AIClassifier } = require('./ai');
const { WhisperClient } = require('./audio/whisperClient');
const { TikTokSource } = require('./sources/tiktok');
const { initDiscord, shutdownDiscord, isDiscordReady, listGuilds, DiscordSource } = require('./sources/discordSource');

const PORT = cfg.get('PORT');

const app = express();
app.use(express.json());

// ---------- Basic Auth (password modificabile dalla UI) ----------
function checkAuth(headerValue) {
  const pw = cfg.get('DASH_PASSWORD');
  if (!pw) return true;
  if (!headerValue || !headerValue.startsWith('Basic ')) return false;
  const decoded = Buffer.from(headerValue.slice(6), 'base64').toString();
  return decoded === `barcello:${pw}`;
}
app.use((req, res, next) => {
  if (checkAuth(req.headers.authorization)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Barcellometro"');
  res.status(401).send('Autenticazione richiesta');
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info) => checkAuth(info.req.headers.authorization),
});

const whisper = new WhisperClient(cfg.get('WHISPER_URL'));
const ai = new AIClassifier({
  provider: cfg.get('AI_PROVIDER'),
  apiKey: cfg.get('ANTHROPIC_API_KEY'),
  model: cfg.get('AI_MODEL') || undefined,
  triggerScore: cfg.get('AI_TRIGGER_SCORE'),
  cooldownSec: cfg.get('AI_COOLDOWN_SEC'),
});

/** sources: id -> { id, platform, name, engine, impl, viewers, audioActive, startedAt, lastWatcherCheck, watcherFired } */
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
    ai: { enabled: ai.enabled, provider: ai.provider, model: ai.enabled ? ai.model : null },
    discordReady: isDiscordReady(),
    watchers: cfg.get('WATCHERS'),
    interventions: cfg.get('INTERVENTIONS'),
    version: require('../package.json').version,
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
  if (ev.points > 0 || ['ai', 'system', 'watcher'].includes(kind)) logEvent(ev);
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

// ---------- Rilevatori personalizzati (watchers) + interventi bot ----------
let watcherBusy = false;
let lastWatcherTick = 0;

async function watcherLoop() {
  if (Date.now() - lastWatcherTick < cfg.get('WATCHER_INTERVAL_SEC') * 1000) return;
  if (watcherBusy || !ai.enabled) return;
  const watchers = (cfg.get('WATCHERS') || []).filter(w => w.enabled);
  const interventions = (cfg.get('INTERVENTIONS') || []).filter(w => w.enabled);
  if (!watchers.length && !interventions.length) return;
  lastWatcherTick = Date.now();
  watcherBusy = true;
  try {
    const wCooldown = cfg.get('WATCHER_COOLDOWN_SEC') * 1000;
    const iCooldown = cfg.get('INTERVENTION_COOLDOWN_SEC') * 1000;
    for (const src of sources.values()) {
      const lastMsg = src.engine.recent[src.engine.recent.length - 1];
      if (!lastMsg || lastMsg.ts <= (src.lastWatcherCheck || 0)) continue; // niente di nuovo
      src.lastWatcherCheck = Date.now();
      src.watcherFired = src.watcherFired || new Map();

      // Condizioni da verificare: watcher (tutte le sorgenti) + interventi (solo Discord)
      const dueW = watchers.filter(w => Date.now() - (src.watcherFired.get(w.id) || 0) > wCooldown);
      const dueI = src.platform === 'discord'
        ? interventions.filter(w => Date.now() - (src.watcherFired.get(w.id) || 0) > iCooldown)
        : [];
      const conditions = [...dueW, ...dueI];
      if (!conditions.length) continue;

      const context = `SCORE BARCELLO ATTUALE: ${src.engine.score}/100\n` + src.engine.contextForAI(30);
      const results = await ai.checkWatchers(context, conditions, `${src.platform}:${src.name}`);
      if (!results) continue;

      for (const r of results) {
        if (!r.match) continue;
        const w = conditions.find(x => x.id === r.id);
        if (!w) continue;
        src.watcherFired.set(w.id, Date.now());

        if (dueI.includes(w)) {
          // Intervento bot Discord (chat e/o voce)
          const text = w.reply || await ai.generateIntervention(context, w, src.name)
            || `Attenzione: rilevato "${w.name}". Il Barcellometro vi tiene d'occhio.`;
          const done = await src.impl.intervene(w.mode, text, cfg.get('TTS_VOICE'));
          const via = [done.chat ? 'chat' : null, done.voice ? 'voce' : null].filter(Boolean).join('+') || 'fallito';
          emitEvent(src, 'bot', `🤖 ${w.name} (${via})`, text, { points: 0, matches: [], notes: [r.evidenza].filter(Boolean) });
        } else {
          // Notifica watcher
          emitEvent(src, 'watcher', `🔔 ${w.name}`, r.evidenza || w.prompt, { points: 0, matches: [], notes: [] });
          broadcast('watcherAlert', { sourceName: src.name, platform: src.platform, watcher: w.name, evidenza: r.evidenza });
        }
      }
    }
  } catch (err) {
    console.error('[watchers]', err.message);
  } finally {
    watcherBusy = false;
  }
}
setInterval(() => { watcherLoop(); }, 5000);

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
    signApiKey: cfg.get('TIKTOK_SIGN_API_KEY') || undefined,
    audioEnabled: cfg.get('AUDIO_ENABLED'),
    chunkSec: cfg.get('AUDIO_CHUNK_SEC'),
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
  if (/rate|429|limit/i.test(m)) return 'Rate limit del sign server: riprova tra qualche minuto (o imposta la API key Euler nelle Impostazioni)';
  return m.slice(0, 200);
}

async function addDiscord({ guildId, textChannelIds, voiceChannelId }) {
  if (!isDiscordReady()) throw new Error('Bot Discord non configurato: imposta il token nelle Impostazioni ⚙️');
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

// ---------- API sorgenti ----------
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

// ---------- API impostazioni ----------
app.get('/api/settings', (req, res) => {
  res.json({ settings: cfg.forUI(), restartKeys: cfg.RESTART_KEYS });
});

app.post('/api/settings', async (req, res) => {
  const oldToken = cfg.get('DISCORD_BOT_TOKEN');
  const oldWhisperModel = cfg.get('WHISPER_MODEL');
  const result = cfg.save(req.body || {});
  const applied = [];

  // AI a caldo
  if (['AI_PROVIDER', 'AI_MODEL', 'ANTHROPIC_API_KEY', 'AI_TRIGGER_SCORE', 'AI_COOLDOWN_SEC'].some(k => result.changed.includes(k))) {
    ai.reconfigure({
      provider: cfg.get('AI_PROVIDER'),
      apiKey: cfg.get('ANTHROPIC_API_KEY'),
      model: cfg.get('AI_MODEL') || undefined,
      triggerScore: cfg.get('AI_TRIGGER_SCORE'),
      cooldownSec: cfg.get('AI_COOLDOWN_SEC'),
    });
    await ai.checkCli();
    applied.push('AI riconfigurata');
  }

  // Discord a caldo
  if (result.changed.includes('DISCORD_BOT_TOKEN')) {
    const newToken = cfg.get('DISCORD_BOT_TOKEN');
    if (oldToken !== newToken) {
      for (const s of [...sources.values()].filter(x => x.platform === 'discord')) {
        removeSource(s.id, 'cambio token Discord');
      }
      await shutdownDiscord();
      if (newToken) {
        try {
          await initDiscord(newToken);
          applied.push('Bot Discord connesso');
        } catch (err) {
          applied.push(`Discord: token non valido (${err.message.slice(0, 80)})`);
        }
      } else {
        applied.push('Bot Discord disattivato');
      }
    }
  }

  // Whisper a caldo
  if (result.changed.includes('WHISPER_MODEL') && cfg.get('WHISPER_MODEL') !== oldWhisperModel) {
    const r = await whisper.reload(cfg.get('WHISPER_MODEL'));
    applied.push(r ? `Whisper ricaricato (${cfg.get('WHISPER_MODEL')})` : 'Whisper: reload fallito (sidecar spento?)');
  }
  if (result.changed.includes('DASH_PASSWORD')) applied.push('Password aggiornata (ricarica la pagina)');

  broadcast('snapshot', snapshot());
  res.json({ ok: true, changed: result.changed, needsRestart: result.needsRestart, applied });
});

app.post('/api/settings/test-ai', async (req, res) => {
  await ai.checkCli();
  if (!ai.enabled) return res.json({ ok: false, error: ai.provider === 'claude-sdk' ? 'CLI claude non disponibile o non autenticata' : 'API key mancante' });
  const t0 = Date.now();
  const fake = { sourceId: '_test', lastAiCall: 0, contextForAI: () => 'utente1: ma stai zitto buffone\nutente2: vergognati, sei ridicolo\nutente1: ci vediamo fuori', score: 100 };
  const verdict = await ai.classify(fake, 'test');
  if (!verdict) return res.json({ ok: false, error: 'nessuna risposta dal modello' });
  res.json({ ok: true, ms: Date.now() - t0, verdict });
});

// ---------- API watchers (rilevatori personalizzati) ----------
app.post('/api/watchers', (req, res) => {
  const list = cfg.get('WATCHERS') || [];
  const { name, prompt } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'Descrivi cosa rilevare' });
  list.push({ id: `w${Date.now()}`, name: String(name || '').trim() || 'Rilevatore', prompt: String(prompt).trim(), enabled: true });
  cfg.save({ WATCHERS: list });
  broadcast('snapshot', snapshot());
  res.json({ ok: true, watchers: cfg.get('WATCHERS') });
});

app.patch('/api/watchers/:id', (req, res) => {
  const list = (cfg.get('WATCHERS') || []).map(w => w.id === req.params.id
    ? { ...w, ...(req.body?.enabled !== undefined ? { enabled: Boolean(req.body.enabled) } : {}), ...(req.body?.name ? { name: String(req.body.name) } : {}), ...(req.body?.prompt ? { prompt: String(req.body.prompt) } : {}) }
    : w);
  cfg.save({ WATCHERS: list });
  broadcast('snapshot', snapshot());
  res.json({ ok: true, watchers: cfg.get('WATCHERS') });
});

app.delete('/api/watchers/:id', (req, res) => {
  const list = (cfg.get('WATCHERS') || []).filter(w => w.id !== req.params.id);
  cfg.save({ WATCHERS: list });
  broadcast('snapshot', snapshot());
  res.json({ ok: true, watchers: cfg.get('WATCHERS') });
});

// ---------- API interventi bot Discord ----------
app.post('/api/interventions', (req, res) => {
  const list = cfg.get('INTERVENTIONS') || [];
  const { name, prompt, mode, reply } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'Descrivi il criterio di intervento' });
  list.push({
    id: `i${Date.now()}`,
    name: String(name || '').trim() || 'Intervento',
    prompt: String(prompt).trim(),
    mode: ['chat', 'voice', 'both'].includes(mode) ? mode : 'chat',
    reply: String(reply || '').trim(),
    enabled: true,
  });
  cfg.save({ INTERVENTIONS: list });
  broadcast('snapshot', snapshot());
  res.json({ ok: true, interventions: cfg.get('INTERVENTIONS') });
});

app.patch('/api/interventions/:id', (req, res) => {
  const list = (cfg.get('INTERVENTIONS') || []).map(w => w.id === req.params.id
    ? {
      ...w,
      ...(req.body?.enabled !== undefined ? { enabled: Boolean(req.body.enabled) } : {}),
      ...(req.body?.name ? { name: String(req.body.name) } : {}),
      ...(req.body?.prompt ? { prompt: String(req.body.prompt) } : {}),
      ...(req.body?.mode ? { mode: String(req.body.mode) } : {}),
      ...(req.body?.reply !== undefined ? { reply: String(req.body.reply) } : {}),
    }
    : w);
  cfg.save({ INTERVENTIONS: list });
  broadcast('snapshot', snapshot());
  res.json({ ok: true, interventions: cfg.get('INTERVENTIONS') });
});

app.delete('/api/interventions/:id', (req, res) => {
  const list = (cfg.get('INTERVENTIONS') || []).filter(w => w.id !== req.params.id);
  cfg.save({ INTERVENTIONS: list });
  broadcast('snapshot', snapshot());
  res.json({ ok: true, interventions: cfg.get('INTERVENTIONS') });
});

// Test rapido intervento (invia subito nel server Discord selezionato)
app.post('/api/interventions/test', async (req, res) => {
  const { sourceId, mode, text } = req.body || {};
  const src = sources.get(sourceId);
  if (!src || src.platform !== 'discord') return res.status(400).json({ error: 'Seleziona una sorgente Discord attiva' });
  const done = await src.impl.intervene(mode || 'chat', text || 'Test del Barcellometro: sistema di intervento operativo. 🍿', cfg.get('TTS_VOICE'));
  res.json({ ok: done.chat || done.voice, done });
});

// ---------- Riavvio dalla UI (systemd rilancia il processo) ----------
app.post('/api/restart', (req, res) => {
  res.json({ ok: true });
  broadcast('event', { event: { ts: Date.now(), sourceId: '_sys', sourceName: 'sistema', platform: 'sys', kind: 'system', user: 'sistema', text: 'Riavvio del server...', points: 0, matches: [], notes: [] } });
  setTimeout(() => process.exit(1), 500);
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
  const threshold = cfg.get('ALERT_THRESHOLD');
  if (global >= threshold && prevGlobal < threshold && now - lastAlertAt > 60000) {
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
  console.log(`   BARCELLOMETRO v${require('../package.json').version}`);
  console.log('===========================================');

  await whisper.checkHealth();
  console.log(`[audio] Whisper: ${whisper.available ? `ATTIVO (modello ${whisper.model})` : 'NON DISPONIBILE (solo chat) - avvia whisper/server.py'}`);
  await ai.checkCli();
  const aiStatus = ai.enabled
    ? `ATTIVO via ${ai.provider === 'claude-sdk' ? 'Claude SDK/subscription' : 'Anthropic API'} (${ai.model})`
    : (ai.provider === 'claude-sdk' ? 'SPENTO (CLI claude non trovata/loggata)' : 'SPENTO (nessuna ANTHROPIC_API_KEY)');
  console.log(`[ai] Classificatore Claude: ${aiStatus}`);
  if (cfg.get('DASH_PASSWORD')) console.log('[auth] Basic Auth attiva (utente: barcello)');

  const token = cfg.get('DISCORD_BOT_TOKEN');
  if (token) {
    try {
      await initDiscord(token);
    } catch (err) {
      console.error('[discord] login fallito:', err.message);
    }
  } else {
    console.log('[discord] Nessun token: configuralo dalla UI (⚙️ Impostazioni)');
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
