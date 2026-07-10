/**
 * BARCELLOMETRO - Sorgente Discord
 * Chat dei canali testuali + audio dei canali vocali (voice receive).
 * Un unico client bot condiviso, piu' monitor per server/canale.
 */

const {
  Client, GatewayIntentBits, ChannelType,
} = require('discord.js');
const {
  joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { pcm16ToWav, rms, down48kStereoTo16kMono } = require('../audio/wav');

let client = null;
let ready = false;

/** Avvia il client bot (una volta sola). Ritorna true se pronto. */
async function initDiscord(token) {
  if (!token) return false;
  if (ready) return true;
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
  await client.login(token);
  await new Promise((resolve) => {
    if (client.isReady()) return resolve();
    client.once('clientReady', resolve);
    client.once('ready', resolve); // compat v14
  });
  ready = true;
  console.log(`[discord] Bot connesso come ${client.user.tag}`);
  return true;
}

function isDiscordReady() { return ready; }

/** Lista server e canali (testo+voce) visibili al bot */
function listGuilds() {
  if (!ready) return [];
  return client.guilds.cache.map((g) => ({
    id: g.id,
    name: g.name,
    textChannels: g.channels.cache
      .filter((c) => c.type === ChannelType.GuildText)
      .map((c) => ({ id: c.id, name: c.name })),
    voiceChannels: g.channels.cache
      .filter((c) => c.type === ChannelType.GuildVoice)
      .map((c) => ({ id: c.id, name: c.name })),
  }));
}

class DiscordSource {
  /**
   * @param {object} cfg { guildId, textChannelIds[], voiceChannelId,
   *                       whisper, onChat, onTranscript, onSystem }
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.guild = null;
    this.voiceConnection = null;
    this.msgHandler = null;
    this.subscriptions = new Map(); // userId -> true
    this.stopped = false;
  }

  async start() {
    if (!ready) throw new Error('Bot Discord non connesso (DISCORD_BOT_TOKEN mancante?)');
    this.guild = client.guilds.cache.get(this.cfg.guildId);
    if (!this.guild) throw new Error('Server non trovato (il bot e’ stato invitato?)');

    // --- Chat ---
    const textIds = new Set(this.cfg.textChannelIds || []);
    this.msgHandler = (msg) => {
      if (this.stopped) return;
      if (msg.guildId !== this.cfg.guildId) return;
      if (msg.author?.bot) return;
      if (textIds.size > 0 && !textIds.has(msg.channelId)) return;
      const content = msg.content || '';
      if (content) this.cfg.onChat(msg.author.username, content, `#${msg.channel?.name || '?'}`);
    };
    client.on('messageCreate', this.msgHandler);
    this.cfg.onSystem(`Monitoraggio chat attivo su ${this.guild.name}${textIds.size ? ` (${textIds.size} canali)` : ' (tutti i canali)'}`);

    // --- Voce ---
    if (this.cfg.voiceChannelId) {
      await this._joinVoice();
    }
    return true;
  }

  async _joinVoice() {
    try {
      this.voiceConnection = joinVoiceChannel({
        channelId: this.cfg.voiceChannelId,
        guildId: this.cfg.guildId,
        adapterCreator: this.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 20000);
      const vc = this.guild.channels.cache.get(this.cfg.voiceChannelId);
      this.cfg.onSystem(`In ascolto nel canale vocale "${vc?.name || this.cfg.voiceChannelId}"`);

      const receiver = this.voiceConnection.receiver;
      receiver.speaking.on('start', (userId) => this._captureUser(receiver, userId));

      this.voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (this.stopped) return;
        try {
          await entersState(this.voiceConnection, VoiceConnectionStatus.Ready, 10000);
        } catch {
          this.cfg.onSystem('Disconnesso dal canale vocale');
        }
      });
    } catch (err) {
      this.cfg.onSystem(`Impossibile entrare nel canale vocale: ${err.message}`);
    }
  }

  _captureUser(receiver, userId) {
    if (this.stopped || this.subscriptions.has(userId)) return;
    this.subscriptions.set(userId, true);

    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];

    opus.pipe(decoder);
    decoder.on('data', (d) => chunks.push(d));

    const finish = async () => {
      this.subscriptions.delete(userId);
      if (this.stopped || chunks.length === 0) return;
      const pcm48 = Buffer.concat(chunks);
      // Minimo ~0.8s di parlato (48kHz stereo s16le = 192000 B/s)
      if (pcm48.length < 150000) return;
      const pcm16k = down48kStereoTo16kMono(pcm48);
      const level = rms(pcm16k);
      if (level < 0.008) return;
      const shouted = level > 0.14;

      const whisper = this.cfg.whisper;
      if (!whisper || !whisper.available) return;
      const text = await whisper.transcribe(pcm16ToWav(pcm16k, 16000, 1));
      if (!text) return;
      let name = userId;
      try {
        const user = client.users.cache.get(userId) || await client.users.fetch(userId);
        name = user.username;
      } catch { /* ignore */ }
      this.cfg.onTranscript(name, text, shouted);
    };

    decoder.on('end', finish);
    decoder.on('error', (e) => { console.error('[discord voice]', e.message); finish(); });
    opus.on('error', (e) => { console.error('[discord voice]', e.message); });
  }

  async stop() {
    this.stopped = true;
    if (this.msgHandler) client.off('messageCreate', this.msgHandler);
    try { this.voiceConnection?.destroy(); } catch { /* ignore */ }
  }
}

module.exports = { initDiscord, isDiscordReady, listGuilds, DiscordSource };
