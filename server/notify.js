/**
 * BARCELLOMETRO - Notifiche esterne: Telegram + Home Assistant (TTS/webhook)
 * Configurabile dalla UI. Nessun invio se non configurato.
 */

class Notifier {
  constructor(getCfg) {
    this.getCfg = getCfg; // funzione che ritorna la config corrente
  }

  cfg(key) { return this.getCfg(key); }

  get telegramEnabled() {
    return Boolean(this.cfg('TELEGRAM_BOT_TOKEN') && this.cfg('TELEGRAM_CHAT_ID'));
  }
  get haEnabled() {
    return Boolean(this.cfg('HA_URL') && this.cfg('HA_TOKEN'));
  }

  /** Invia un messaggio Telegram */
  async telegram(text) {
    if (!this.telegramEnabled) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.cfg('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.cfg('TELEGRAM_CHAT_ID'), text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch (err) {
      console.error('[notify/telegram]', err.message);
      return false;
    }
  }

  /** Annuncio TTS via Home Assistant (tts.speak) o notify webhook */
  async homeAssistant(message) {
    if (!this.haEnabled) return false;
    const base = String(this.cfg('HA_URL')).replace(/\/$/, '');
    const headers = { 'authorization': `Bearer ${this.cfg('HA_TOKEN')}`, 'content-type': 'application/json' };
    const player = this.cfg('HA_MEDIA_PLAYER');
    const ttsEntity = this.cfg('HA_TTS_ENTITY') || 'tts.google_translate_say';
    try {
      if (player) {
        // tts.speak verso un media_player
        const res = await fetch(`${base}/api/services/tts/speak`, {
          method: 'POST', headers,
          body: JSON.stringify({ entity_id: ttsEntity, media_player_entity_id: player, message }),
          signal: AbortSignal.timeout(8000),
        });
        return res.ok;
      }
      // fallback: persistent_notification
      const res = await fetch(`${base}/api/services/persistent_notification/create`, {
        method: 'POST', headers,
        body: JSON.stringify({ title: 'Barcellometro', message }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch (err) {
      console.error('[notify/ha]', err.message);
      return false;
    }
  }

  /** Notifica su entrambi i canali abilitati */
  async broadcast(text, ttsText) {
    const results = await Promise.allSettled([
      this.telegram(text),
      this.homeAssistant(ttsText || text.replace(/<[^>]+>/g, '')),
    ]);
    return { telegram: results[0].value || false, ha: results[1].value || false };
  }
}

module.exports = { Notifier };
