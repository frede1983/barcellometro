/**
 * BARCELLOMETRO - Sorgente TikTok LIVE
 * Chat via tiktok-live-connector (v2) + audio via ffmpeg sull'HLS della live.
 */

const { spawn } = require('child_process');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
const { pcm16ToWav, rms } = require('../audio/wav');

class TikTokSource {
  /**
   * @param {string} username  @username TikTok
   * @param {object} opts { signApiKey, audioEnabled, chunkSec, whisper,
   *                        onChat(user,text), onTranscript(speaker,text,shouted),
   *                        onSystem(msg), onViewers(n), onEnd() }
   */
  constructor(username, opts) {
    this.username = username.replace(/^@/, '');
    this.opts = opts;
    this.connection = null;
    this.ffmpeg = null;
    this.stopped = false;
    this.audioActive = false;
    this._pcmBuf = [];
    this._pcmLen = 0;
    this._rmsAvg = 0.03;
    this._reconnectTimer = null;
  }

  async start() {
    const options = { fetchRoomInfoOnConnect: true };
    if (this.opts.signApiKey) options.signApiKey = this.opts.signApiKey;
    this.connection = new TikTokLiveConnection(this.username, options);

    this.connection.on(WebcastEvent.CHAT, (data) => {
      const user = data.user?.uniqueId || data.user?.nickname || 'anonimo';
      if (data.comment) this.opts.onChat(user, data.comment);
    });

    this.connection.on(WebcastEvent.ROOM_USER, (data) => {
      if (typeof data.viewerCount === 'number') this.opts.onViewers(data.viewerCount);
    });

    this.connection.on(WebcastEvent.STREAM_END, () => {
      this.opts.onSystem('La live e’ terminata');
      this.stop();
      this.opts.onEnd();
    });

    this.connection.on(ControlEvent.DISCONNECTED, () => {
      if (this.stopped) return;
      this.opts.onSystem('Disconnesso da TikTok, riprovo tra 30s...');
      this._stopAudio();
      this._reconnectTimer = setTimeout(() => this._reconnect(), 30000);
    });

    this.connection.on(ControlEvent.ERROR, (err) => {
      const msg = err?.info || err?.exception?.message || 'errore sconosciuto';
      console.error(`[tiktok:${this.username}]`, msg);
    });

    const state = await this.connection.connect();
    this.opts.onSystem(`Connesso alla live di @${this.username} (room ${state.roomId})`);

    if (this.opts.audioEnabled) this._startAudio();
    return true;
  }

  async _reconnect() {
    if (this.stopped) return;
    try {
      await this.connection.connect();
      this.opts.onSystem('Riconnesso a TikTok');
      if (this.opts.audioEnabled) this._startAudio();
    } catch {
      this._reconnectTimer = setTimeout(() => this._reconnect(), 30000);
    }
  }

  _streamUrl() {
    const info = this.connection?.roomInfo;
    const su = info?.stream_url;
    if (!su) return null;
    return su.hls_pull_url || su.flv_pull_url || (su.flv_pull_url_map && Object.values(su.flv_pull_url_map)[0]) || null;
  }

  async _startAudio() {
    if (this.audioActive || this.stopped) return;
    let url = this._streamUrl();
    if (!url) {
      try {
        await this.connection.fetchRoomInfo();
        url = this._streamUrl();
      } catch { /* ignore */ }
    }
    if (!url) {
      this.opts.onSystem('URL stream non trovato: analisi audio non disponibile per questa live');
      return;
    }

    const chunkSec = this.opts.chunkSec || 8;
    const chunkBytes = 16000 * 2 * chunkSec;

    this.ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-headers', 'Referer: https://www.tiktok.com/\r\n',
      '-i', url,
      '-vn', '-ac', '1', '-ar', '16000',
      '-f', 's16le', 'pipe:1',
    ], { windowsHide: true });

    this.audioActive = true;
    this.opts.onSystem(`Analisi audio attiva (chunk da ${chunkSec}s)`);

    this.ffmpeg.stdout.on('data', (buf) => {
      this._pcmBuf.push(buf);
      this._pcmLen += buf.length;
      if (this._pcmLen >= chunkBytes) {
        const pcm = Buffer.concat(this._pcmBuf, this._pcmLen);
        this._pcmBuf = [];
        this._pcmLen = 0;
        this._processChunk(pcm.subarray(0, chunkBytes));
      }
    });

    this.ffmpeg.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error(`[ffmpeg:${this.username}] ${s.slice(0, 200)}`);
    });

    this.ffmpeg.on('close', (code) => {
      this.audioActive = false;
      this.ffmpeg = null;
      if (!this.stopped && code !== 0) {
        this.opts.onSystem('Pipeline audio interrotta, riprovo tra 20s...');
        setTimeout(() => this._startAudio(), 20000);
      }
    });

    this.ffmpeg.on('error', (err) => {
      this.audioActive = false;
      if (err.code === 'ENOENT') {
        this.opts.onSystem('ffmpeg non trovato: analisi audio disattivata (installa ffmpeg e riavvia)');
      } else {
        console.error(`[ffmpeg:${this.username}]`, err.message);
      }
    });
  }

  async _processChunk(pcm) {
    const level = rms(pcm);
    if (level < 0.008) return; // silenzio
    // Media mobile del volume per rilevare urla relative al baseline della live
    this._rmsAvg = this._rmsAvg * 0.9 + level * 0.1;
    const shouted = level > Math.max(0.1, this._rmsAvg * 1.9);

    const whisper = this.opts.whisper;
    if (!whisper || !whisper.available) return;
    const text = await whisper.transcribe(pcm16ToWav(pcm, 16000, 1));
    if (text) this.opts.onTranscript(`@${this.username} (live)`, text, shouted);
  }

  _stopAudio() {
    if (this.ffmpeg) {
      try { this.ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
      this.ffmpeg = null;
    }
    this.audioActive = false;
    this._pcmBuf = [];
    this._pcmLen = 0;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this._reconnectTimer);
    this._stopAudio();
    try { await this.connection?.disconnect(); } catch { /* ignore */ }
  }
}

module.exports = { TikTokSource };
