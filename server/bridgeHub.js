/**
 * BARCELLOMETRO - Bridge Hub (lato server/VPS)
 * Riceve la connessione dallo script locale (PC di casa, IP residenziale) che
 * si collega a TikTok e inoltra gli eventi. Il server invia comandi start/stop.
 *
 * Protocollo (JSON su WebSocket):
 *  Bridge -> Server:
 *    {t:'hello', version}
 *    {t:'connected', username, roomId}
 *    {t:'streamUrl', username, url}
 *    {t:'event', username, kind:'chat'|'gift'|'social'|'match'|'viewers'|'join', ...}
 *    {t:'streamEnd', username}
 *    {t:'error', username, message}
 *  Server -> Bridge:
 *    {t:'start', username}
 *    {t:'stop', username}
 *    {t:'ping'}
 */

class BridgeHub {
  constructor() {
    this.socket = null;         // una sola connessione bridge attiva
    this.connectedAt = null;
    this.info = null;           // {version}
    this.handlers = {};         // username -> callbacks
    this.wanted = new Set();    // username che vogliamo monitorare
    this.roomState = {};        // username -> {roomId, streamUrl}
  }

  get connected() { return Boolean(this.socket && this.socket.readyState === 1); }

  status() {
    return {
      connected: this.connected,
      connectedAt: this.connectedAt,
      version: this.info?.version || null,
      active: [...this.wanted],
    };
  }

  attach(ws, onStatusChange) {
    // sostituisce eventuale bridge precedente
    if (this.socket && this.socket !== ws) {
      try { this.socket.close(); } catch { /* ignore */ }
    }
    this.socket = ws;
    this.connectedAt = Date.now();
    this._onStatusChange = onStatusChange;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._handle(msg);
    });
    ws.on('close', () => {
      if (this.socket === ws) {
        this.socket = null;
        this.connectedAt = null;
        this.info = null;
        if (this._onStatusChange) this._onStatusChange();
      }
    });
    ws.on('error', () => { /* close seguira' */ });

    // richiedi al bridge di avviare tutto cio' che vogliamo (riconnessione)
    for (const u of this.wanted) this._send({ t: 'start', username: u });
    if (this._onStatusChange) this._onStatusChange();
  }

  _send(obj) {
    if (this.connected) {
      try { this.socket.send(JSON.stringify(obj)); return true; } catch { /* ignore */ }
    }
    return false;
  }

  _handle(msg) {
    if (msg.t === 'hello') { this.info = { version: msg.version }; if (this._onStatusChange) this._onStatusChange(); return; }
    const u = (msg.username || '').replace(/^@/, '').toLowerCase();
    const h = this.handlers[u];
    if (msg.t === 'connected') { this.roomState[u] = { roomId: msg.roomId }; h?.onConnected?.(msg.roomId); return; }
    if (msg.t === 'streamUrl') { (this.roomState[u] = this.roomState[u] || {}).streamUrl = msg.url; h?.onStreamUrl?.(msg.url); return; }
    if (msg.t === 'streamEnd') { h?.onEnd?.(); return; }
    if (msg.t === 'error') { h?.onError?.(msg.message); return; }
    if (msg.t === 'event' && h) {
      switch (msg.kind) {
        case 'chat': h.onChat?.(msg.user, msg.text, null, { avatar: msg.avatar, displayName: msg.displayName }); break;
        case 'gift': h.onGift?.(msg.user, msg.value, msg.giftName, msg.count, { avatar: msg.avatar, displayName: msg.displayName }); break;
        case 'social': h.onSocial?.(msg.user, msg.socialType, msg.count, { avatar: msg.avatar }); break;
        case 'join': h.onJoin?.(msg.user, { avatar: msg.avatar, displayName: msg.displayName }); break;
        case 'viewers': h.onViewers?.(msg.count); break;
        case 'match': h.onMatch?.(msg.opponent, msg.names || []); break;
        default: break;
      }
    }
  }

  /** Registra i callback per un username e chiede al bridge di avviarlo */
  start(username, callbacks) {
    const u = username.replace(/^@/, '').toLowerCase();
    this.handlers[u] = callbacks;
    this.wanted.add(u);
    return this._send({ t: 'start', username: u });
  }

  stop(username) {
    const u = username.replace(/^@/, '').toLowerCase();
    delete this.handlers[u];
    this.wanted.delete(u);
    delete this.roomState[u];
    this._send({ t: 'stop', username: u });
  }
}

module.exports = { BridgeHub };
