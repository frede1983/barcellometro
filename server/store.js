/**
 * BARCELLOMETRO - Store persistente: profili utente + registro attività.
 * Persistenza leggera su JSON (utenti) + append-only JSONL giornaliero (registro).
 * Gli utenti sono identificati da "platform:username".
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = {}; }

let watchlist = [];
try { watchlist = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8')); } catch { watchlist = []; }
function saveWatchlist() { fs.writeFile(WATCH_FILE, JSON.stringify(watchlist), () => {}); }

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(USERS_FILE, JSON.stringify(users), () => {});
  }, 2000);
}

function keyOf(platform, username) {
  return `${platform}:${String(username || '').replace(/^@/, '').toLowerCase()}`;
}

/** Crea/aggiorna un profilo utente. Ritorna il record. */
function touchUser(platform, username, extra = {}) {
  const key = keyOf(platform, username);
  const now = Date.now();
  let u = users[key];
  if (!u) {
    u = {
      key, platform,
      username: String(username || '').replace(/^@/, ''),
      displayName: extra.displayName || null,
      avatar: extra.avatar || null,
      firstSeen: now, lastSeen: now,
      sources: [],
      hosts: {},             // host(sorgente) -> {firstSeen, lastSeen, visits, chat, audio, donations, putt}
      counts: { chat: 0, audio: 0, join: 0 },
      barcelloPoints: 0,     // somma punti barcello generati
      maxSingle: 0,          // singolo evento piu' "caldo"
      donationTotal: 0,      // valore donazioni totale (diamanti)
      donationCount: 0,      // numero di gift inviati
      putt: 0,               // punti fedelta' community
      violations: [],        // {ts, rule, action, detail, source}
      samples: [],           // ultimi messaggi/trascrizioni {ts, kind, text, points, source}
      donations: [],         // ultimi gift {ts, source, gift, value, count}
    };
    users[key] = u;
  }
  u.lastSeen = now;
  if (extra.displayName) u.displayName = extra.displayName;
  if (extra.avatar) u.avatar = extra.avatar;
  if (!u.hosts) u.hosts = {};
  if (extra.source) {
    const wasNew = !u.sources.includes(extra.source);
    if (wasNew) u.sources.push(extra.source);
    const h = u.hosts[extra.source] || (u.hosts[extra.source] = { firstSeen: now, lastSeen: now, visits: 0, chat: 0, audio: 0, donations: 0, putt: 0 });
    h.lastSeen = now;
    // nuova "visita" se non si vedeva da >5 min su quell'host
    if (extra.newVisit && now - (h._lastVisitTs || 0) > 300000) { h.visits++; h._lastVisitTs = now; }
  }
  scheduleSave();
  return u;
}

/** Registra un messaggio/trascrizione nel profilo */
function recordActivity(platform, username, kind, text, points, source) {
  const u = touchUser(platform, username, { source, newVisit: kind === 'join' });
  const h = u.hosts[source];
  if (kind === 'chat') { u.counts.chat++; if (h) h.chat++; }
  else if (kind === 'audio') { u.counts.audio++; if (h) h.audio++; }
  else if (kind === 'join') u.counts.join++;
  if (points > 0) {
    u.barcelloPoints += points;
    if (points > u.maxSingle) u.maxSingle = points;
  }
  if (['chat', 'audio'].includes(kind) && text) {
    u.samples.push({ ts: Date.now(), kind, text: String(text).slice(0, 300), points: points || 0, source });
    if (u.samples.length > 40) u.samples.shift();
  }
  recomputePutt(u);
  scheduleSave();
  return u;
}

/** Registra una donazione (gift). value = diamanti. */
function recordDonation(platform, username, value, giftName, count, source, meta = {}) {
  const u = touchUser(platform, username, { source, avatar: meta.avatar, displayName: meta.displayName });
  const v = Math.max(0, Number(value) || 0);
  u.donationTotal += v;
  u.donationCount += 1;
  const h = u.hosts[source];
  if (h) h.donations += v;
  u.donations.push({ ts: Date.now(), source, gift: giftName || 'gift', value: v, count: count || 1 });
  if (u.donations.length > 60) u.donations.shift();
  recomputePutt(u);
  scheduleSave();
  return u;
}

/**
 * Punti PUTT = fedelta' alla community.
 * Donazioni (peso alto) + presenza ripetuta allo stesso host + attivita' chat/audio,
 * con bonus fedelta' se concentrata su un singolo host.
 */
function recomputePutt(u) {
  let total = 0;
  const hostVals = [];
  for (const host of Object.values(u.hosts || {})) {
    const hv = host.donations * 1.0 + host.visits * 8 + host.chat * 0.3 + host.audio * 0.8;
    host.putt = Math.round(hv);
    hostVals.push(hv);
    total += hv;
  }
  // bonus fedelta': se >70% dei punti viene da un solo host
  if (hostVals.length && total > 0) {
    const top = Math.max(...hostVals);
    if (top / total > 0.7) total *= 1.15;
  }
  u.putt = Math.round(total);
  return u.putt;
}

/** Registra una violazione/azione di moderazione nel profilo */
function recordViolation(platform, username, rule, action, detail, source) {
  const u = touchUser(platform, username, { source });
  u.violations.push({ ts: Date.now(), rule, action, detail, source });
  if (u.violations.length > 100) u.violations.shift();
  scheduleSave();
  return u;
}

/** Lista sintetica profili (per la griglia) */
function listUsers({ platform, source, sort = 'lastSeen', limit = 300 } = {}) {
  let arr = Object.values(users);
  if (platform) arr = arr.filter(u => u.platform === platform);
  if (source) arr = arr.filter(u => u.sources.includes(source));
  const sorters = {
    lastSeen: (a, b) => b.lastSeen - a.lastSeen,
    barcello: (a, b) => b.barcelloPoints - a.barcelloPoints,
    violations: (a, b) => b.violations.length - a.violations.length,
    messages: (a, b) => (b.counts.chat + b.counts.audio) - (a.counts.chat + a.counts.audio),
    donations: (a, b) => b.donationTotal - a.donationTotal,
    putt: (a, b) => b.putt - a.putt,
  };
  arr.sort(sorters[sort] || sorters.lastSeen);
  return arr.slice(0, limit).map(summary);
}

function summary(u) {
  return {
    key: u.key, platform: u.platform, username: u.username, displayName: u.displayName,
    avatar: u.avatar, firstSeen: u.firstSeen, lastSeen: u.lastSeen,
    sources: u.sources, counts: u.counts,
    barcelloPoints: Math.round(u.barcelloPoints),
    donationTotal: Math.round(u.donationTotal || 0),
    donationCount: u.donationCount || 0,
    putt: u.putt || 0,
    hostCount: Object.keys(u.hosts || {}).length,
    violations: u.violations.length,
    watched: isWatched(u.platform, u.username),
  };
}

function getUser(key) {
  return users[key] || null;
}

// ---------- Rubrica (watchlist) ----------
function watchKey(platform, username) { return `${platform}:${String(username || '').replace(/^@/, '').toLowerCase()}`; }
function isWatched(platform, username) {
  const wk = watchKey(platform, username);
  return watchlist.some(w => watchKey(w.platform, w.username) === wk);
}
function addWatch(platform, username, note) {
  if (isWatched(platform, username)) return watchlist;
  watchlist.push({ platform, username: String(username).replace(/^@/, ''), note: note || '', addedAt: Date.now() });
  saveWatchlist();
  return watchlist;
}
function removeWatch(platform, username) {
  const wk = watchKey(platform, username);
  watchlist = watchlist.filter(w => watchKey(w.platform, w.username) !== wk);
  saveWatchlist();
  return watchlist;
}
function listWatch() {
  // arricchisci con stato dal profilo
  return watchlist.map(w => {
    const u = users[keyOf(w.platform, w.username)];
    return {
      ...w,
      lastSeen: u?.lastSeen || null,
      hosts: u ? Object.keys(u.hosts || {}) : [],
      putt: u?.putt || 0,
      donationTotal: u ? Math.round(u.donationTotal || 0) : 0,
    };
  });
}

// ---------- Registro attività (append-only JSONL) ----------
function logActivity(entry) {
  const rec = { ts: Date.now(), ...entry };
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFile(path.join(LOG_DIR, `discord-${day}.jsonl`), JSON.stringify(rec) + '\n', () => {});
  return rec;
}

/** Legge il registro Discord degli ultimi N giorni con filtri */
function readDiscordLog({ days = 2, guild, kind, user, limit = 500 } = {}) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `discord-${day}.jsonl`);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').trim().split('\n'); } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (guild && r.guild !== guild) continue;
        if (kind && r.kind !== kind) continue;
        if (user && !(r.user || '').toLowerCase().includes(user.toLowerCase())) continue;
        out.push(r);
      } catch { /* ignore */ }
    }
  }
  return out.slice(-limit).reverse();
}

module.exports = {
  touchUser, recordActivity, recordViolation, recordDonation, listUsers, getUser,
  logActivity, readDiscordLog, keyOf,
  isWatched, addWatch, removeWatch, listWatch,
};
