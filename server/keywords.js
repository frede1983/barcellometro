/**
 * BARCELLOMETRO - Dizionario italiano del barcello
 * Ogni voce: [pattern, peso 1-10]. I pattern sono confrontati su testo
 * normalizzato (minuscolo, senza accenti). Le frasi multi-parola contano di piu'.
 */

const KEYWORDS = [
  // --- Insulti pesanti (8-10) ---
  ['vaffanculo', 9], ['vaffa', 7], ['fanculo', 8], ['affanculo', 8],
  ['figlio di puttana', 10], ['figli di puttana', 10], ['pezzo di merda', 10],
  ['pezzente', 8], ['bastardo', 8], ['bastarda', 8],
  ['stronzo', 8], ['stronza', 8], ['coglione', 8], ['cogliona', 8], ['coglioni', 7],
  ['testa di cazzo', 9], ['faccia di merda', 9], ['merdaccia', 8],
  ['puttana', 8], ['troia', 8], ['zoccola', 8], ['infame', 8], ['verme', 7],
  ['fai schifo', 8], ['fate schifo', 7], ['mi fai schifo', 9],
  ['ti ammazzo', 10], ['ti spacco', 9], ['ti meno', 9], ['ti gonfio', 8],
  ['ti sfondo', 8], ['ti apro', 8], ['ti stacco la testa', 10],

  // --- Insulti medi (4-7) ---
  ['ridicolo', 5], ['ridicola', 5], ['patetico', 6], ['patetica', 6],
  ['buffone', 6], ['buffona', 6], ['pagliaccio', 6], ['clown', 5],
  ['sfigato', 6], ['sfigata', 6], ['fallito', 6], ['fallita', 6],
  ['poveraccio', 5], ['poveretto', 4], ['cesso', 5], ['pippa', 4],
  ['incapace', 4], ['ignorante', 4], ['cretino', 5], ['cretina', 5],
  ['idiota', 5], ['imbecille', 6], ['deficiente', 6], ['demente', 6],
  ['scemo', 4], ['scema', 4], ['stupido', 4], ['stupida', 4],
  ['vergognati', 6], ['vergognatevi', 5], ['che vergogna', 5],
  ['stai zitto', 6], ['stai zitta', 6], ['zitto tu', 6], ['chiudi la bocca', 7],
  ['muto', 4], ['muta', 4], ['taci', 5],
  ['chi ti conosce', 5], ['nessuno ti caga', 6], ['nessuno ti conosce', 5],
  ['rosica', 5], ['rosichi', 5], ['rosicone', 6], ['rosicona', 6], ['hai rosicato', 6],
  ['gne gne', 3], ['piagnone', 4], ['frignone', 4],

  // --- Minacce legali / escalation (4-8) ---
  ['querela', 6], ['querelo', 7], ['ti querelo', 8], ['denuncia', 5], ['ti denuncio', 8],
  ['diffida', 5], ['avvocato', 4], ['avvocati', 4], ['ti faccio causa', 7],
  ['vieni qui', 5], ['ci vediamo fuori', 8], ['ti aspetto fuori', 8], ['fatti vedere', 5],
  ['hai paura', 5], ['codardo', 6], ['vigliacco', 6], ['non vali niente', 7],
  ['sei nessuno', 6], ['sei un nessuno', 7], ['ti distruggo', 8], ['ti rovino', 8],
  ['ti sputtano', 8], ['ti espongo', 7], ['ti smaschero', 7], ['smascherato', 6],
  ['bugiardo', 6], ['bugiarda', 6], ['falso', 5], ['falsa', 5], ['fake', 4],
  ['hai copiato', 5], ['ladro', 6], ['ladra', 6], ['truffatore', 7], ['truffatrice', 7],
  ['scammer', 6], ['truffa', 5], ['hai truffato', 7],

  // --- Marker di barcello / drama (3-7) ---
  ['barcello', 7], ['barcellamento', 7], ['che barcello', 8],
  ['rissa', 6], ['litigio', 5], ['litigano', 6], ['stanno litigando', 7],
  ['dissing', 5], ['diss ', 4], ['drama', 4], ['trash talk', 5], ['treshtalk', 5],
  ['si menano', 7], ['botte', 4], ['alle mani', 6], ['scontro', 4],
  ['faida', 5], ['beef', 4], ['shade', 3], ['frecciatina', 4], ['frecciata', 4],
  ['provocazione', 4], ['provoca', 3], ['sta provocando', 5],
  ['sclerato', 5], ['sta sclerando', 6], ['sclera', 4], ['fuori di testa', 4],
  ['e partito', 3], ['e scoppiato', 5], ['sta succedendo', 4],

  // --- Hype del pubblico (2-4): la chat che gusta il barcello ---
  ['popcorn', 4], ['clippate', 4], ['clippa', 3], ['clip it', 3],
  ['screenshot', 2], ['registrate', 3], ['sta registrando', 3],
  ['olio sul fuoco', 4], ['gas gas', 3], ['menatevi', 5], ['picchiatevi', 5],
  ['che trash', 4], ['madonna che', 2], ['sto volando', 2], ['sto male', 2],
];

// Emoji tipiche del barcello
const EMOJI = [
  ['\u{1F37F}', 4],       // popcorn
  ['\u{1F525}', 2],       // fire
  ['\u{1F480}', 2],       // skull
  ['\u{1F44A}', 3],       // punch
  ['\u{1F94A}', 4],       // boxing glove
  ['\u{26A0}', 2],        // warning
  ['\u{1F631}', 2],       // scream
  ['\u{1F92C}', 5],       // cursing face
  ['\u{1F621}', 3],       // rage
  ['\u{1F620}', 2],       // angry
];

/** Normalizza: minuscolo, rimuove accenti, comprime spazi */
const COMBINING = new RegExp('[\\u0300-\\u036f]', 'g');
function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pre-compila regex con confini di parola (le frasi restano ricerca substring)
const COMPILED = KEYWORDS.map(([kw, w]) => {
  const isPhrase = kw.includes(' ');
  const escaped = kw.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = isPhrase
    ? new RegExp(escaped, 'g')
    : new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'g');
  return { kw: kw.trim(), w, re };
});

/**
 * Analizza un testo, ritorna { points, matches: [{kw, w}] }
 * I match ripetuti nello stesso messaggio contano una volta sola (anti-spam).
 */
function scoreText(text) {
  const norm = normalize(text);
  if (!norm) return { points: 0, matches: [] };
  const matches = [];
  let points = 0;
  for (const { kw, w, re } of COMPILED) {
    re.lastIndex = 0;
    if (re.test(norm)) {
      matches.push({ kw, w });
      points += w;
    }
  }
  for (const [emoji, w] of EMOJI) {
    if ((text || '').includes(emoji)) {
      matches.push({ kw: emoji, w });
      points += w;
    }
  }
  return { points, matches };
}

module.exports = { scoreText, normalize };
