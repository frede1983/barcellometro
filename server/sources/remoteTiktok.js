/**
 * BARCELLOMETRO - Sorgente TikTok REMOTA (via bridge)
 * Gli eventi chat/gift/social/match arrivano dallo script locale (IP residenziale)
 * tramite il BridgeHub. L'audio viene gestito qui sul server usando lo streamUrl
 * pubblico inoltrato dal bridge (la CDN TikTok è raggiungibile anche dal VPS).
 */

const { spawn } = require('child_process');
const { pcm16ToWav, rms } = require('../audio/wav');

class RemoteTikTokSource {
  constructor(username, opts) {
    this.username = username.replace(/^@/, '');
    this.opts = opts;           // { hub, audioEnabled, chunkSec, audioLang, whisper, onChat, onTranscript, onSystem, onViewers, onGift, onSocial, onJoin, onMatch, onEnd }
    this.ffmpeg = null;
    this.audioActive = false;
    this.stopped = false;
    this._pcmBuf = [];
    this._pcmLen = 0;
    this._rmsAvg = 0.03;
    this.streamUrl = null;
  }

  async start() {
    const cb = {
      onChat: this.opts.onChat,
      onGift: this.opts.onGift,
      onSocial: this.opts.onSocial,
      onJoin: this.opts.onJoin,
      onMatch: this.opts.onMatch,
      onViewers: this.opts.onViewers,
      onConnected: (roomId) => this.opts.onSystem(`Bridge collegato alla live di @${this.username} (room ${roomId})`),
      onStreamUrl: (url) => { this.streamUrl = url; if (this.opts.audioEnabled) this._startAudio(); },
      onEnd: () => { this.opts.onSystem('La live è terminata'); this.stop(); this.opts.onEnd(); },
      onError: (m) => this.opts.onSystem(`Bridge: ${m}`),
    };
    const ok = this.opts.hub.start(this.username, cb);
    if (!ok) {
      this.opts.onSystem('Bridge non connesso: avvia lo script locale sul PC di casa');
    } else {
      this.opts.onSystem(`Richiesto al bridge il monitoraggio di @${this.username}`);
    }
    return true;
  }

  async _startAudio() {
    if (this.audioActive || this.stopped || !this.streamUrl) return;
    const chunkSec = this.opts.chunkSec || 8;
    const chunkBytes = 16000 * 2 * chunkSec;
    this.ffmpeg = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-headers', 'Referer: https://www.tiktok.com/\r\n',
      '-i', this.streamUrl,
      '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
    ], { windowsHide: true });
    this.audioActive = true;
    this.opts.onSystem(`Analisi audio attiva (chunk ${chunkSec}s, via streamUrl del bridge)`);

    this.ffmpeg.stdout.on('data', (buf) => {
      this._pcmBuf.push(buf); this._pcmLen += buf.length;
      if (this._pcmLen >= chunkBytes) {
        const pcm = Buffer.concat(this._pcmBuf, this._pcmLen);
        this._pcmBuf = []; this._pcmLen = 0;
        this._processChunk(pcm.subarray(0, chunkBytes));
      }
    });
    this.ffmpeg.stderr.on('data', () => { /* ignora rumore ffmpeg */ });
    this.ffmpeg.on('close', () => { this.audioActive = false; this.ffmpeg = null; });
    this.ffmpeg.on('error', (err) => {
      this.audioActive = false;
      if (err.code === 'ENOENT') this.opts.onSystem('ffmpeg non trovato: audio disattivato');
    });
  }

  async _processChunk(pcm) {
    const level = rms(pcm);
    if (level < 0.008) return;
    this._rmsAvg = this._rmsAvg * 0.9 + level * 0.1;
    const shouted = level > Math.max(0.1, this._rmsAvg * 1.9);
    const whisper = this.opts.whisper;
    if (!whisper || !whisper.available) return;
    const text = await whisper.transcribe(pcm16ToWav(pcm, 16000, 1), this.opts.audioLang || 'it');
    if (text) this.opts.onTranscript(`@${this.username} (live)`, text, shouted);
  }

  _stopAudio() {
    if (this.ffmpeg) { try { this.ffmpeg.kill('SIGKILL'); } catch { /* ignore */ } this.ffmpeg = null; }
    this.audioActive = false; this._pcmBuf = []; this._pcmLen = 0;
  }

  async stop() {
    this.stopped = true;
    this._stopAudio();
    this.opts.hub.stop(this.username);
  }
}

module.exports = { RemoteTikTokSource };
