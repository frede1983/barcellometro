/**
 * BARCELLOMETRO - Utility audio PCM/WAV
 */

/** Avvolge PCM s16le in un header WAV */
function pcm16ToWav(pcm, sampleRate = 16000, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34);           // bits
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** RMS normalizzato 0-1 di un buffer PCM s16le */
function rms(pcm) {
  if (!pcm || pcm.length < 2) return 0;
  const samples = Math.floor(pcm.length / 2);
  const step = Math.max(1, Math.floor(samples / 8000)); // campiona per performance
  let sum = 0, n = 0;
  for (let i = 0; i < samples; i += step) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Downsample PCM s16le 48kHz stereo -> 16kHz mono (media canali, 1 campione su 3) */
function down48kStereoTo16kMono(pcm) {
  const frames = Math.floor(pcm.length / 4); // 2 canali * 2 byte
  const outFrames = Math.floor(frames / 3);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const src = i * 3 * 4;
    const l = pcm.readInt16LE(src);
    const r = pcm.readInt16LE(src + 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, (l + r) >> 1)), i * 2);
  }
  return out;
}

module.exports = { pcm16ToWav, rms, down48kStereoTo16kMono };
