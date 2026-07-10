/**
 * BARCELLOMETRO - Classificatore AI ibrido
 * Due provider:
 *  - "claude-sdk": usa la CLI di Claude Code (subscription, nessun costo per token).
 *                  Richiede `claude` installato e loggato (o CLAUDE_CODE_OAUTH_TOKEN).
 *  - "api":        Anthropic API diretta (richiede ANTHROPIC_API_KEY).
 * Quando lo score keyword supera la soglia, chiede a Claude se e' vero barcello.
 */

const { spawn } = require('child_process');

const API_URL = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `Sei il giudice del "Barcellometro", un rilevatore di litigi e dissing nelle live italiane (TikTok/Discord).
Ricevi gli ultimi messaggi di chat e/o trascrizioni audio di una live.
Devi stabilire se e' in corso un BARCELLO: un litigio reale, un dissing, uno scontro verbale tra persone (streamer vs streamer, streamer vs chat, utenti tra loro).
NON e' barcello: scherzi bonari tra amici, trash talk da videogioco amichevole, citazioni/karaoke, ironia evidente senza bersaglio, hype generico.
Rispondi SOLO con JSON valido, nessun altro testo:
{"barcello": true|false, "intensita": 0-100, "protagonisti": ["nome1","nome2"], "sintesi": "una frase in italiano"}
intensita: 0-30 tranquillo, 40-60 tensione/frecciatine, 60-80 litigio acceso, 80-100 rissa verbale totale.`;

class AIClassifier {
  constructor({ provider, apiKey, model, triggerScore, cooldownSec }) {
    this.apiKey = apiKey || '';
    // auto: claude-sdk se non c'e' API key, altrimenti api
    this.provider = provider || (this.apiKey ? 'api' : 'claude-sdk');
    if (this.provider === 'off') this.provider = 'off';
    this.model = model || (this.provider === 'claude-sdk' ? 'haiku' : 'claude-haiku-4-5-20251001');
    this.triggerScore = triggerScore || 40;
    this.cooldownMs = (cooldownSec || 90) * 1000;
    this.pending = new Set();
    this.cliAvailable = null; // verificato all'avvio
  }

  get enabled() {
    if (this.provider === 'api') return Boolean(this.apiKey);
    if (this.provider === 'claude-sdk') return this.cliAvailable !== false;
    return false;
  }

  /** Verifica che la CLI `claude` sia installata e utilizzabile */
  async checkCli() {
    if (this.provider !== 'claude-sdk') return;
    this.cliAvailable = await new Promise((resolve) => {
      try {
        const p = spawn('claude', ['--version'], { shell: process.platform === 'win32', windowsHide: true });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        const to = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(false); }, 15000);
        p.on('close', (code) => { clearTimeout(to); resolve(code === 0 && out.length > 0); });
        p.on('error', () => { clearTimeout(to); resolve(false); });
      } catch { resolve(false); }
    });
    return this.cliAvailable;
  }

  shouldClassify(engine) {
    if (!this.enabled) return false;
    if (this.pending.has(engine.sourceId)) return false;
    if (engine.score < this.triggerScore) return false;
    if (Date.now() - engine.lastAiCall < this.cooldownMs) return false;
    return true;
  }

  /** Ritorna il verdetto {barcello, intensita, protagonisti, sintesi} o null */
  async classify(engine, sourceName) {
    engine.lastAiCall = Date.now();
    this.pending.add(engine.sourceId);
    try {
      const context = engine.contextForAI(25);
      if (!context.trim()) return null;
      const userPrompt = `Live: ${sourceName}\nUltimi messaggi/trascrizioni:\n${context}\n\nVerdetto JSON:`;
      const raw = this.provider === 'claude-sdk'
        ? await this._viaCli(userPrompt)
        : await this._viaApi(userPrompt);
      if (!raw) return null;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const verdict = JSON.parse(jsonMatch[0]);
      return {
        barcello: Boolean(verdict.barcello),
        intensita: Math.max(0, Math.min(100, Number(verdict.intensita) || 0)),
        protagonisti: Array.isArray(verdict.protagonisti) ? verdict.protagonisti.slice(0, 4) : [],
        sintesi: String(verdict.sintesi || '').slice(0, 200),
      };
    } catch (err) {
      console.error('[ai] errore:', err.message);
      return null;
    } finally {
      this.pending.delete(engine.sourceId);
    }
  }

  /** Claude Code CLI in modalita' headless: prompt via stdin, output JSON */
  _viaCli(userPrompt) {
    return new Promise((resolve) => {
      const args = [
        '-p',
        '--output-format', 'json',
        '--model', this.model,
        '--append-system-prompt', SYSTEM,
      ];
      const p = spawn('claude', args, {
        shell: process.platform === 'win32',
        windowsHide: true,
        env: { ...process.env },
      });
      let out = '', err = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
      const to = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(null); }, 90000);
      p.on('close', () => {
        clearTimeout(to);
        try {
          const parsed = JSON.parse(out);
          resolve(typeof parsed.result === 'string' ? parsed.result : null);
        } catch {
          if (err) console.error('[ai/cli]', err.slice(0, 300));
          resolve(null);
        }
      });
      p.on('error', (e) => {
        clearTimeout(to);
        console.error('[ai/cli] spawn fallito:', e.message);
        resolve(null);
      });
      p.stdin.write(userPrompt);
      p.stdin.end();
    });
  }

  /** Anthropic API diretta */
  async _viaApi(userPrompt) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      console.error(`[ai] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return (data.content || []).map(b => b.text || '').join('');
  }
}

module.exports = { AIClassifier };
