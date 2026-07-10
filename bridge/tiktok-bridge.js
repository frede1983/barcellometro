#!/usr/bin/env node
/**
 * BARCELLOMETRO - Bridge TikTok locale
 * Da eseguire sul PC di CASA (IP residenziale, dove la firma TikTok anonima passa).
 * Si collega al Barcellometro sul VPS via WebSocket, riceve i comandi start/stop
 * e inoltra tutti gli eventi delle live TikTok.
 *
 * Config: variabili d'ambiente o bridge/.env
 *   BARCELLO_URL   es. ws://srv1013438.hstgr.cloud:3900   (o wss://... dietro proxy TLS)
 *   BRIDGE_TOKEN   lo stesso token impostato nel Barcellometro
 *   TIKTOK_SESSION_ID  opzionale (cookie sessionid)
 */

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch { /* dotenv opzionale */ }

const WebSocket = require('ws');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
const { pickAvatar } = require('../server/sources/avatar');

const RAW_URL = process.env.BARCELLO_URL || 'ws://localhost:3900';
const TOKEN = process.env.BRIDGE_TOKEN || '';
const SESSION_ID = process.env.TIKTOK_SESSION_ID || '';

if (!TOKEN) {
  console.error('[bridge] ERRORE: BRIDGE_TOKEN mancante. Impostalo (stesso valore del Barcellometro).');
  process.exit(1);
}

// Normalizza in ws://host:porta/bridge?token=...
function wsUrl() {
  let u = RAW_URL.replace(/\/$/, '');
  if (!/^wss?:\/\//.test(u)) u = 'ws://' + u.replace(/^https?:\/\//, '');
  if (!u.endsWith('/bridge')) u += '/bridge';
  return `${u}?token=${encodeURIComponent(TOKEN)}`;
}

const connections = new Map(); // username -> TikTokLiveConnection
let ws = null;
let reconnectTimer = null;

function send(obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function connectHub() {
  const url = wsUrl();
  console.log(`[bridge] Connessione al Barcellometro: ${url.replace(/token=[^&]+/, 'token=***')}`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[bridge] Collegato al Barcellometro ✓');
    send({ t: 'hello', version: '1.4.0' });
  });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'start') startTikTok(msg.username);
    else if (msg.t === 'stop') stopTikTok(msg.username);
    else if (msg.t === 'ping') send({ t: 'pong' });
  });

  ws.on('close', () => {
    console.log('[bridge] Disconnesso dal Barcellometro, riprovo tra 5s...');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectHub, 5000);
  });
  ws.on('error', (e) => console.error('[bridge] errore WS:', e.message));
}

async function startTikTok(username) {
  const u = String(username || '').replace(/^@/, '');
  if (!u || connections.has(u)) return;
  console.log(`[bridge] Avvio monitoraggio @${u}`);

  const options = {
    processInitialData: true,
    fetchRoomInfoOnConnect: true,
    requestPollingIntervalMs: 2000,
    enableExtendedGiftInfo: Boolean(SESSION_ID),
    ...(SESSION_ID ? { sessionId: SESSION_ID } : {}),
  };
  const conn = new TikTokLiveConnection(u, options);
  connections.set(u, conn);

  conn.on(WebcastEvent.CHAT, (d) => {
    if (!d.comment) return;
    send({ t: 'event', username: u, kind: 'chat', user: d.user?.uniqueId || d.user?.nickname || 'anonimo', text: d.comment, avatar: pickAvatar(d), displayName: d.user?.nickname || null });
  });
  conn.on(WebcastEvent.ROOM_USER, (d) => {
    if (typeof d.viewerCount === 'number') send({ t: 'event', username: u, kind: 'viewers', count: d.viewerCount });
  });
  conn.on(WebcastEvent.MEMBER, (d) => {
    const user = d.user?.uniqueId || d.user?.nickname;
    if (user) send({ t: 'event', username: u, kind: 'join', user, avatar: pickAvatar(d), displayName: d.user?.nickname || null });
  });
  conn.on(WebcastEvent.GIFT, (d) => {
    const giftType = d.giftDetails?.giftType ?? d.giftType;
    if (giftType === 1 && d.repeatEnd === false) return;
    const repeat = d.repeatCount || 1;
    const diamonds = (d.giftDetails?.diamondCount ?? d.extendedGiftInfo?.diamond_count ?? 0) * repeat;
    send({ t: 'event', username: u, kind: 'gift', user: d.user?.uniqueId || d.user?.nickname || 'anonimo', value: diamonds, giftName: d.giftDetails?.giftName || `gift ${d.giftId || ''}`, count: repeat, avatar: pickAvatar(d), displayName: d.user?.nickname || null });
  });
  const social = (type) => (d) => {
    const user = d.user?.uniqueId || d.user?.nickname;
    if (user) send({ t: 'event', username: u, kind: 'social', socialType: type, count: type === 'like' ? (d.likeCount || 1) : 1, user, avatar: pickAvatar(d) });
  };
  if (WebcastEvent.SHARE) conn.on(WebcastEvent.SHARE, social('share'));
  if (WebcastEvent.FOLLOW) conn.on(WebcastEvent.FOLLOW, social('follow'));
  if (WebcastEvent.LIKE) conn.on(WebcastEvent.LIKE, social('like'));
  const battle = (d) => {
    try {
      const list = Array.isArray(d.battleUsers || d.anchorInfo) ? (d.battleUsers || d.anchorInfo) : Object.values(d.anchorInfo || {});
      const names = list.map(a => a?.user?.uniqueId || a?.uniqueId || a?.user?.nickName).filter(Boolean).map(n => String(n).replace(/^@/, ''));
      const opp = names.find(n => n.toLowerCase() !== u.toLowerCase());
      if (opp) send({ t: 'event', username: u, kind: 'match', opponent: opp, names });
    } catch { /* ignore */ }
  };
  if (WebcastEvent.LINK_MIC_BATTLE) conn.on(WebcastEvent.LINK_MIC_BATTLE, battle);
  if (WebcastEvent.LINK_MIC_ARMIES) conn.on(WebcastEvent.LINK_MIC_ARMIES, battle);

  conn.on(WebcastEvent.STREAM_END, () => { send({ t: 'streamEnd', username: u }); stopTikTok(u); });
  conn.on(ControlEvent.ERROR, (e) => console.error(`[bridge:@${u}]`, e?.info || e?.exception?.message || 'errore'));

  try {
    const state = await conn.connect();
    console.log(`[bridge] @${u} connesso (room ${state.roomId})`);
    send({ t: 'connected', username: u, roomId: state.roomId });
    // stream URL per l'audio lato server
    const su = conn.roomInfo?.stream_url;
    const url = su && (su.hls_pull_url || su.flv_pull_url || (su.flv_pull_url_map && Object.values(su.flv_pull_url_map)[0]));
    if (url) send({ t: 'streamUrl', username: u, url });
  } catch (err) {
    console.error(`[bridge] @${u} connessione fallita:`, err.message);
    send({ t: 'error', username: u, message: err.message });
    connections.delete(u);
    try { conn.disconnect(); } catch { /* ignore */ }
  }
}

function stopTikTok(username) {
  const u = String(username || '').replace(/^@/, '');
  const conn = connections.get(u);
  if (conn) {
    try { conn.disconnect(); } catch { /* ignore */ }
    connections.delete(u);
    console.log(`[bridge] Stop @${u}`);
  }
}

console.log('=== BARCELLOMETRO Bridge TikTok (locale) ===');
connectHub();

process.on('SIGINT', () => {
  for (const u of [...connections.keys()]) stopTikTok(u);
  process.exit(0);
});
