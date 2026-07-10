/**
 * BARCELLOMETRO - Storico score + clip dei picchi
 * - Storico: campiona lo score globale e per-sorgente ogni SAMPLE_SEC, in RAM
 *   (ring buffer ~2h) + persistenza giornaliera JSONL per il replay.
 * - Clip: quando lo score supera la soglia, cattura una finestra di eventi
 *   (chat + trascrizioni) attorno al picco e la salva come highlight.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const CLIPS_FILE = path.join(DATA_DIR, 'clips.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const SAMPLE_SEC = 5;
const RAM_POINTS = Math.ceil((2 * 3600) / SAMPLE_SEC); // ~2h

let ram = [];         // {ts, global, perSource: {name: score}}
let clips = [];
try { clips = JSON.parse(fs.readFileSync(CLIPS_FILE, 'utf8')); } catch { clips = []; }
function saveClips() { fs.writeFile(CLIPS_FILE, JSON.stringify(clips), () => {}); }

function sample(global, sources) {
  const point = { ts: Date.now(), global, perSource: {} };
  for (const s of sources) point.perSource[s.name] = s.score;
  ram.push(point);
  if (ram.length > RAM_POINTS) ram.shift();
  // persistenza (una riga ogni campione)
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFile(path.join(LOG_DIR, `storico-${day}.jsonl`), JSON.stringify(point) + '\n', () => {});
}

/** Storico in RAM per il grafico (ultimi `minutes`) */
function recent(minutes = 60) {
  const since = Date.now() - minutes * 60000;
  return ram.filter(p => p.ts >= since);
}

/** Storico persistito per il replay (giorno YYYY-MM-DD) */
function replayDay(day) {
  const file = path.join(LOG_DIR, `storico-${day}.jsonl`);
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

// ---------- Clip di picco ----------
function addClip(clip) {
  const rec = {
    id: `clip${Date.now()}`,
    ts: Date.now(),
    ...clip,
  };
  clips.unshift(rec);
  if (clips.length > 200) clips.pop();
  saveClips();
  return rec;
}

function listClips(limit = 100) {
  return clips.slice(0, limit).map(c => ({
    id: c.id, ts: c.ts, sourceName: c.sourceName, platform: c.platform,
    peakScore: c.peakScore, title: c.title, eventCount: (c.events || []).length,
    audioFile: c.audioFile || null,
  }));
}

function getClip(id) {
  return clips.find(c => c.id === id) || null;
}

module.exports = { sample, recent, replayDay, addClip, listClips, getClip, SAMPLE_SEC };
