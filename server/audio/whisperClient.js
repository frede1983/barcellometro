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

  /** Trascrive un WAV. Ritorna stringa (vuota se niente parlato o servizio giu'). */
  async transcribe(wavBuffer) {
    if (!this.available) return '';
    if (this._busy > 2) return ''; // backpressure: salta chunk se whisper e' indietro
    this._busy++;
    try {
      const res = await fetch(`${this.baseUrl}/transcribe?lang=it`, {
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
