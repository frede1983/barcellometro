/**
 * BARCELLOMETRO - Motore di scoring
 * Ogni sorgente ha un "heat" 0-100 che sale con gli eventi e decade nel tempo
 * (emivita 45s). Euristiche: keyword, CAPS, punteggiatura, picchi di velocita',
 * ping-pong tra due utenti, urla in audio, verdetto AI.
 */

const { scoreText } = require('./keywords');

const HALF_LIFE_SEC = 45;
const LEVELS = [
  { min: 80, name: 'BARCELLO TOTALE', emoji: '\u{1F525}\u{1F37F}' },
  { min: 60, name: 'BARCELLO!', emoji: '\u{1F94A}' },
  { min: 40, name: 'Frizione rilevata', emoji: '\u{26A0}\u{FE0F}' },
  { min: 20, name: 'Tensione nell\'aria', emoji: '\u{1F440}' },
  { min: 0, name: 'Quiete piatta', emoji: '\u{1F4A4}' },
];

function levelFor(score) {
  return LEVELS.find(l => score >= l.min);
}

class ScoreEngine {
  constructor(sourceId) {
    this.sourceId = sourceId;
    this.heat = 0;
    this.lastDecay = Date.now();
    this.recent = [];            // {ts, user, text, points}
    this.lastSpikeBonus = 0;
    this.lastPingPongBonus = 0;
    this.msgTimestamps = [];
    this.baselineRate = 0.2;     // msg/sec EMA
    this.lastAiCall = 0;
    this.userLastKw = new Map(); // anti-spam: user -> {kw -> ts}
  }

  _decay() {
    const now = Date.now();
    const dt = (now - this.lastDecay) / 1000;
    if (dt > 0.5) {
      this.heat *= Math.pow(0.5, dt / HALF_LIFE_SEC);
      if (this.heat < 0.1) this.heat = 0;
      this.lastDecay = now;
    }
  }

  _add(points) {
    this._decay();
    this.heat = Math.min(120, this.heat + points); // overshoot ammesso, clamp in lettura
  }

  get score() {
    this._decay();
    return Math.min(100, Math.round(this.heat));
  }

  /** Deduplica keyword ripetute dallo stesso utente entro 20s */
  _dedupe(user, matches) {
    const now = Date.now();
    let m = this.userLastKw.get(user);
    if (!m) { m = new Map(); this.userLastKw.set(user, m); }
    return matches.filter(({ kw }) => {
      const last = m.get(kw) || 0;
      m.set(kw, now);
      return now - last > 20000;
    });
  }

  /**
   * Analizza un messaggio chat. Ritorna null se irrilevante,
   * altrimenti { points, matches, notes[] }
   */
  addChat(user, text) {
    const now = Date.now();
    this.msgTimestamps.push(now);
    this.msgTimestamps = this.msgTimestamps.filter(t => now - t < 60000);

    const base = scoreText(text);
    const matches = this._dedupe(user, base.matches);
    let points = matches.reduce((s, m) => s + m.w, 0);
    const notes = [];

    // CAPS LOCK
    const letters = (text || '').replace(/[^a-zA-ZÀ-ÿ]/g, '');
    if (letters.length >= 8) {
      const caps = letters.replace(/[^A-ZÀ-Ü]/g, '').length / letters.length;
      if (caps > 0.7) { points += 3; notes.push('CAPS'); }
    }
    // Punteggiatura aggressiva
    if (/[!?]{3,}/.test(text || '')) { points += 1.5; notes.push('!!!'); }

    this.recent.push({ ts: now, user, text, points });
    if (this.recent.length > 60) this.recent.shift();

    // Picco di velocita' della chat (la chat esplode = sta succedendo qualcosa)
    const rate10 = this.msgTimestamps.filter(t => now - t < 10000).length / 10;
    this.baselineRate = this.baselineRate * 0.98 + rate10 * 0.02;
    if (rate10 > Math.max(0.6, this.baselineRate * 3) && now - this.lastSpikeBonus > 30000) {
      const anyKw = this.recent.slice(-15).some(r => r.points >= 3);
      if (anyKw) {
        points += 6;
        this.lastSpikeBonus = now;
        notes.push('PICCO CHAT');
      }
    }

    // Ping-pong: 2 utenti che si alternano con toni ostili (litigio 1v1)
    if (points > 0 && now - this.lastPingPongBonus > 45000) {
      const last8 = this.recent.slice(-8).filter(r => now - r.ts < 40000);
      const hostile = last8.filter(r => r.points >= 3);
      const users = [...new Set(hostile.map(r => r.user))];
      if (users.length === 2 && hostile.length >= 4) {
        let alternations = 0;
        for (let i = 1; i < hostile.length; i++) {
          if (hostile[i].user !== hostile[i - 1].user) alternations++;
        }
        if (alternations >= 3) {
          points += 10;
          this.lastPingPongBonus = now;
          notes.push(`LITIGIO 1v1: ${users.join(' vs ')}`);
        }
      }
    }

    if (points <= 0) return null;
    this._add(points);
    return { points: Math.round(points * 10) / 10, matches, notes };
  }

  /**
   * Analizza una trascrizione audio (parlato pesa di piu' della chat).
   * shouted: true se il volume RMS indica urla.
   */
  addTranscript(speaker, text, shouted = false) {
    const base = scoreText(text);
    let points = base.points * 1.5;
    const notes = [];
    if (shouted && base.points > 0) { points += 10; notes.push('URLA + INSULTI'); }
    else if (shouted) { points += 4; notes.push('TONI ALTI'); }
    if (points <= 0) return null;
    this.recent.push({ ts: Date.now(), user: speaker, text: `[audio] ${text}`, points });
    if (this.recent.length > 60) this.recent.shift();
    this._add(points);
    return { points: Math.round(points * 10) / 10, matches: base.matches, notes };
  }

  /** Fonde il verdetto AI nello score */
  blendAI(verdict) {
    this._decay();
    if (verdict.barcello) {
      const target = Math.max(this.heat, Math.min(100, verdict.intensita || 60));
      this.heat = target;
    } else {
      this.heat *= 0.55; // l'AI dice falso allarme: smorza
    }
  }

  /** Contesto per l'AI: ultimi messaggi rilevanti */
  contextForAI(n = 25) {
    return this.recent.slice(-n).map(r => `${r.user}: ${r.text}`).join('\n');
  }
}

module.exports = { ScoreEngine, levelFor, LEVELS };
