/**
 * BARCELLOMETRO - Client per il sidecar Whisper
 */

class WhisperClient {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:3901').replace(/\/$/, '');
    this.available = false;
    this.model = null;
    this._busy = 0;
  }

  async checkHealth() {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      this.available = Boolean(data.ok);
      this.model = data.model || null;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /** Cambia modello a caldo sul sidecar */
  async reload(model) {
    try {
      const res = await fetch(`${this.baseUrl}/reload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(180000), // il download del modello puo' essere lento
      });
      const data = await res.json();
      if (data.ok) this.model = data.model;
      return Boolean(data.ok);
    } catch {
      return false;
    }
  }

  /** Sintesi vocale (Edge TTS via sidecar). Ritorna Buffer mp3 o null. */
  async tts(text, voice) {
    try {
      const res = await fetch(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 500 ? buf : null;
    } catch {
      return null;
    }
  }

  /** Trascrive un WAV. Ritorna stringa (vuota se niente parlato o servizio giu'). */
  async transcribe(wavBuffer, lang = 'it') {
    if (!this.available) return '';
    if (this._busy > 2) return ''; // backpressure: salta chunk se whisper e' indietro
    this._busy++;
    try {
      const res = await fetch(`${this.baseUrl}/transcribe?lang=${encodeURIComponent(lang)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: wavBuffer,
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) return '';
      const data = await res.json();
      return (data.text || '').trim();
    } catch (err) {
      console.error('[whisper] errore:', err.message);
      return '';
    } finally {
      this._busy--;
    }
  }
}

module.exports = { WhisperClient };
