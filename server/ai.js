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
  constructor(opts) {
    this.pending = new Set();
    this.cliAvailable = null; // verificato all'avvio
    this.reconfigure(opts);
  }

  /** Applica (o ri-applica a caldo) la configurazione */
  reconfigure({ provider, apiKey, model, triggerScore, cooldownSec }) {
    this.apiKey = apiKey || '';
    this.provider = provider || (this.apiKey ? 'api' : 'claude-sdk');
    this.model = model || (this.provider === 'claude-sdk' ? 'haiku' : 'claude-haiku-4-5-20251001');
    this.triggerScore = triggerScore || 40;
    this.cooldownMs = (cooldownSec || 90) * 1000;
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
        ? await this._viaCli(userPrompt, SYSTEM)
        : await this._viaApi(userPrompt, SYSTEM);
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

  /**
   * Rilevatori personalizzati: controlla in un'unica chiamata quali condizioni
   * definite dall'utente sono soddisfatte dal contesto recente.
   * watchers: [{id, name, prompt}] -> ritorna [{id, match, evidenza}] o null
   */
  async checkWatchers(context, watchers, sourceName) {
    if (!this.enabled || !watchers.length || !context.trim()) return null;
    const lista = watchers.map(w => `- id "${w.id}": ${w.name} -> ${w.prompt}`).join('\n');
    const sys = `Sei un analista di live italiane (TikTok/Discord). Ricevi gli ultimi messaggi di chat e trascrizioni audio di una live e una lista di CONDIZIONI DI RILEVAMENTO definite dall'utente.
Per OGNI condizione stabilisci se e' chiaramente soddisfatta nel contesto (non basta una parola ambigua: serve che se ne parli davvero).
Rispondi SOLO con JSON valido:
{"risultati":[{"id":"...","match":true|false,"evidenza":"breve citazione o frase che lo dimostra, vuota se match=false"}]}`;
    const userPrompt = `Live: ${sourceName}\n\nCONDIZIONI:\n${lista}\n\nCONTESTO:\n${context}\n\nJSON:`;
    try {
      const raw = this.provider === 'claude-sdk'
        ? await this._viaCli(userPrompt, sys)
        : await this._viaApi(userPrompt, sys);
      if (!raw) return null;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.risultati)) return null;
      return parsed.risultati.map(r => ({
        id: String(r.id || ''),
        match: Boolean(r.match),
        evidenza: String(r.evidenza || '').slice(0, 200),
      }));
    } catch (err) {
      console.error('[ai/watchers] errore:', err.message);
      return null;
    }
  }

  /**
   * Moderazione AI: applica il regolamento scritto dall'utente al contesto recente.
   * roster: elenco utenti citabili. allowed: azioni permesse.
   * Ritorna { azioni: [{utente, azione, motivo, messaggioPubblico, durataMin, regolaViolata}] } o null.
   */
  async moderate(context, rules, allowed, maxTimeoutMin, roster, sourceName) {
    if (!this.enabled || !rules.trim() || !context.trim()) return null;
    const azioniPermesse = Object.entries(allowed).filter(([, v]) => v).map(([k]) => k);
    if (!azioniPermesse.length) return null;
    const sys = `Sei il MODERATORE AI di un server Discord italiano. Applichi il REGOLAMENTO fornito dal proprietario, con equità e senza eccessi.
Ricevi gli ultimi messaggi/trascrizioni (chat e vocale) e devi decidere SE e COME agire.
Regole di condotta:
- Interviene solo per violazioni CHIARE del regolamento. Nel dubbio, non agire.
- Scegli l'azione MINIMA efficace e proporzionata a quanto scritto nel regolamento.
- Puoi usare SOLO queste azioni: ${azioniPermesse.join(', ')}. (warn=avviso testuale; voice=avviso vocale; delete=cancella l'ultimo messaggio offensivo; timeout=silenzia N minuti, max ${maxTimeoutMin}; kick=espelli; ban=bandisci)
- "none" per nessuna azione su quell'utente.
- messaggioPubblico: breve, fermo, educato, in italiano, MAI offensivo. Cita la regola.
Rispondi SOLO con JSON valido:
{"azioni":[{"utente":"nome esatto dal roster","azione":"warn|voice|delete|timeout|kick|ban|none","regolaViolata":"...","motivo":"...","messaggioPubblico":"...","durataMin":numero_solo_per_timeout}]}
Se non c'e' nulla da moderare: {"azioni":[]}`;
    const userPrompt = `Server: ${sourceName}\nUtenti presenti (usa questi nomi esatti): ${roster.join(', ') || 'n/d'}\n\nREGOLAMENTO:\n${rules}\n\nCONTESTO RECENTE:\n${context}\n\nDecisione JSON:`;
    try {
      const raw = this.provider === 'claude-sdk'
        ? await this._viaCli(userPrompt, sys)
        : await this._viaApi(userPrompt, sys);
      if (!raw) return null;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.azioni)) return null;
      return parsed.azioni
        .filter(a => a && a.azione && a.azione !== 'none' && azioniPermesse.includes(a.azione))
        .map(a => ({
          utente: String(a.utente || '').slice(0, 80),
          azione: a.azione,
          regolaViolata: String(a.regolaViolata || '').slice(0, 150),
          motivo: String(a.motivo || '').slice(0, 200),
          messaggioPubblico: String(a.messaggioPubblico || '').slice(0, 250),
          durataMin: Math.max(1, Math.min(maxTimeoutMin, Number(a.durataMin) || 5)),
        }));
    } catch (err) {
      console.error('[ai/moderazione] errore:', err.message);
      return null;
    }
  }

  /**
   * Genera il messaggio di intervento del bot (breve, italiano) in base
   * al contesto della live e al criterio scattato.
   */
  async generateIntervention(context, intervention, sourceName) {
    if (!this.enabled) return null;
    const sys = `Sei "Barcellometro", il bot ufficiale anti-drama di un server Discord italiano. Tono: simpatico, diretto, un filo teatrale, MAI offensivo, max 2 frasi brevi.
Devi scrivere UN SOLO messaggio di intervento da inviare ora nel canale, coerente con il motivo dell'intervento e con quello che sta succedendo.
Niente prefissi, niente virgolette, niente emoji eccessive (max 2). Rispondi SOLO con il messaggio.`;
    const userPrompt = `Server: ${sourceName}\nMotivo intervento: ${intervention.name} — ${intervention.prompt}\n\nContesto recente:\n${context}\n\nMessaggio:`;
    try {
      const raw = this.provider === 'claude-sdk'
        ? await this._viaCli(userPrompt, sys)
        : await this._viaApi(userPrompt, sys);
      if (!raw) return null;
      return raw.trim().replace(/^["']|["']$/g, '').slice(0, 250);
    } catch (err) {
      console.error('[ai/intervento] errore:', err.message);
      return null;
    }
  }

  /** Claude Code CLI in modalita' headless: prompt via stdin, output JSON */
  _viaCli(userPrompt, systemPrompt) {
    return new Promise((resolve) => {
      const args = [
        '-p',
        '--output-format', 'json',
        '--model', this.model,
        '--append-system-prompt', systemPrompt || SYSTEM,
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
  async _viaApi(userPrompt, systemPrompt) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 500,
        system: systemPrompt || SYSTEM,
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
