/**
 * Keeps slurs and hateful or sexually abusive names out of the token lists. Anyone can name a token anything, and brand
 * new tokens are full of abusive names; Aretia does not want to put them in front of people.
 *
 * It looks at whole words (after undoing common disguises: numbers for letters, stretched letters, spaces between
 * letters), not at fragments, so innocent names are not caught ("Grape", "Class", "Scunthorpe", "Niger", "Passion").
 * A word list can never catch everything, and it is not a judgement about a token's safety: the risk rating is separate.
 */

/** Words hidden when they stand alone as a word in a name or symbol. */
const WORDS = [
  'fag', 'fags', 'faggot', 'faggots', 'nigger', 'niggers', 'nigga', 'niggas', 'retard', 'retards', 'retarded', 'kike', 'kikes', 'spic', 'spics',
  'chink', 'chinks', 'gook', 'gooks', 'tranny', 'trannies', 'coon', 'coons', 'paki', 'pakis', 'cunt', 'cunts', 'twat', 'whore', 'whores', 'slut', 'sluts',
  'rape', 'rapes', 'raped', 'rapist', 'rapists', 'pedo', 'pedos', 'pedophile', 'paedophile', 'nazi', 'nazis', 'hitler', 'kys', 'porn', 'porno', 'dyke', 'wetback', 'beaner',
  'cock', 'cocks', 'pussy', 'dick', 'dicks', 'cum', 'blowjob', 'anal',
];

/** Longer words also hidden when the letters of the whole name, run together, spell them (catches "n i g g e r"). */
const RUN_TOGETHER = ['nigger', 'nigga', 'faggot', 'pedophile', 'paedophile'];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

/** A pattern for a word that allows letters to be stretched, but keeps genuinely doubled letters doubled ("niger" is not "nigger"). */
function stretched(word: string): RegExp {
  const parts: string[] = [];
  for (let i = 0; i < word.length; ) {
    let j = i;
    while (j < word.length && word[j] === word[i]) j++;
    const run = j - i;
    parts.push(`${word[i]}{${run},}`);
    i = j;
  }
  return new RegExp(`^${parts.join('')}$`);
}

const WORD_PATTERNS = WORDS.map(stretched);
const RUN_PATTERNS = RUN_TOGETHER.map((w) => new RegExp(w.split('').map((c) => `${c}+`).join('')));

function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[0134578@$!]/g, (c) => LEET[c] ?? c);
}

/** True if a token name or symbol contains an abusive word. */
export function isOffensive(...texts: (string | null | undefined)[]): boolean {
  for (const t of texts) {
    if (!t) continue;
    const n = normalise(t);
    if (n.split(/[^a-z]+/).some((w) => w.length > 1 && WORD_PATTERNS.some((p) => p.test(w)))) return true;
    const squashed = n.replace(/[^a-z]/g, '');
    if (squashed.length <= 40 && RUN_PATTERNS.some((p) => p.test(squashed))) return true;
  }
  return false;
}

/**
 * Look-alike letters from other alphabets (Cyrillic, Armenian, Cherokee, Greek, Lisu) and the "styled" Latin letters of
 * Unicode (fullwidth ＵＳＤＣ, mathematical 𝖴𝖲𝖣𝖢 and 𝐔𝐒𝐃𝐂) are how a scam token passes for a real one: the top pool of a
 * busy network can be a "USDT" spelled with Armenian and Cherokee letters. Names containing them are hidden. Names entirely
 * in another writing system (Chinese, Korean, Arabic and so on) are not touched.
 */
const LOOKALIKE = /[\u0370-\u03ff\u0400-\u052f\u0530-\u058f\u13a0-\u13ff\u1c80-\u1c8f\u2c80-\u2cff\ua4d0-\ua4ff\uab70-\uabbf\uff01-\uff5e\u{1d400}-\u{1d7ff}]/u;

export function hasLookalikeLetters(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && LOOKALIKE.test(t));
}

/** True if a name or symbol should be kept off the lists: abusive, or dressed up with look-alike letters. */
export function isUnsafeName(...texts: (string | null | undefined)[]): boolean {
  return isOffensive(...texts) || hasLookalikeLetters(...texts);
}

// ---------------------------------------------------------------- invisible characters

/**
 * Characters that change how text is drawn without being seen: controls, zero-width and joiner characters, bidirectional
 * marks and overrides (including the Arabic letter mark U+061C), the byte-order mark U+FEFF, the invisible operators
 * U+2060-2064, the Mongolian vowel separator U+180E, the combining grapheme joiner, and the general-purpose combining marks
 * that can be stacked over Latin letters (accents used by real names are precomposed once the text is NFC-normalised).
 */
// eslint-disable-next-line no-control-regex, no-misleading-character-class -- the class lists code points to remove, combining marks on purpose
export const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;

/** Text from a chain or a market source made safe to store and show: NFC, invisible and stacking characters out, trimmed, cut to length. */
export function cleanText(s: string, max: number): string {
  return [...s.normalize('NFC').replace(UNSAFE_CHARS, '').trim()].slice(0, max).join('');
}

// ---------------------------------------------------------------- impersonation

/** Common look-alike letters folded to the Latin letter they imitate (a small part of Unicode's confusables table). */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', Ѕ: 'S', І: 'I', Ј: 'J', Ԁ: 'D', Ԛ: 'Q', Ԝ: 'W', Ꙅ: 'S',
  а: 'A', е: 'E', о: 'O', р: 'P', с: 'C', у: 'Y', х: 'X', ѕ: 'S', і: 'I', ј: 'J', ԁ: 'D', һ: 'H', ԛ: 'Q', ԝ: 'W', ӏ: 'L',
  // Greek
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', ο: 'O', ν: 'V', τ: 'T', ι: 'I', κ: 'K', ρ: 'P', υ: 'U',
  // Armenian
  Ս: 'U', Տ: 'S', Օ: 'O', Լ: 'L', Ք: 'P', ս: 'U', օ: 'O', հ: 'H', ո: 'N', զ: 'Q',
  // Cherokee
  Ꭺ: 'A', Ᏼ: 'B', Ꮯ: 'C', Ꭰ: 'D', Ꭼ: 'E', Ꮋ: 'H', Ꮖ: 'I', Ꭻ: 'J', Ꮶ: 'K', Ꮮ: 'L', Ꮇ: 'M', Ꮲ: 'P', Ꭱ: 'R', Ꮪ: 'S', Ꭲ: 'T', Ꮩ: 'V', Ꮃ: 'W', Ꮓ: 'Z', Ꮤ: 'W', Ꮟ: 'B',
  // Lisu
  ꓮ: 'A', ꓐ: 'B', ꓚ: 'C', ꓓ: 'D', ꓰ: 'E', ꓝ: 'F', ꓖ: 'G', ꓧ: 'H', ꓲ: 'I', ꓙ: 'J', ꓗ: 'K', ꓡ: 'L', ꓟ: 'M', ꓠ: 'N', ꓳ: 'O', ꓑ: 'P', ꓣ: 'R', ꓢ: 'S', ꓔ: 'T', ꓴ: 'U', ꓦ: 'V', ꓪ: 'W', ꓫ: 'X', ꓬ: 'Y', ꓜ: 'Z',
  // Cyrillic lower case that reads as a Latin capital in a short symbol ("uѕdт")
  т: 'T', к: 'K', м: 'M', н: 'H', в: 'B',
  // Latin small capitals (Phonetic Extensions, IPA and Latin Extended-D): "ᴜꜱᴅᴄ"
  ᴀ: 'A', ʙ: 'B', ᴄ: 'C', ᴅ: 'D', ᴇ: 'E', ꜰ: 'F', ɢ: 'G', ʜ: 'H', ɪ: 'I', ᴊ: 'J', ᴋ: 'K', ʟ: 'L', ᴍ: 'M', ɴ: 'N', ᴏ: 'O', ᴘ: 'P', ꞯ: 'Q', ʀ: 'R', ꜱ: 'S', ᴛ: 'T', ᴜ: 'U', ᴠ: 'V', ᴡ: 'W', ʏ: 'Y', ᴢ: 'Z',
  // Latin letters with hooks, strokes and bars, and turned or reversed forms, that pass for plain ones ("USDƇ", "USÐC", "ɅCT", "ꞫTH")
  Ɓ: 'B', Ƀ: 'B', ƀ: 'B', Ꞵ: 'B', ꞵ: 'B', Ƈ: 'C', ƈ: 'C', Ȼ: 'C', ȼ: 'C', Ð: 'D', ð: 'D', Đ: 'D', đ: 'D', Ɖ: 'D', Ɗ: 'D', ɗ: 'D',
  Ɛ: 'E', ɛ: 'E', Ǝ: 'E', Ɇ: 'E', ɇ: 'E', Ɜ: 'E', ɜ: 'E', Ƒ: 'F', ƒ: 'F', Ɠ: 'G', ɠ: 'G', Ǥ: 'G', ǥ: 'G', Ħ: 'H', ħ: 'H', Ɨ: 'I', ɨ: 'I',
  Ɉ: 'J', ɉ: 'J', Ƙ: 'K', ƙ: 'K', Ł: 'L', ł: 'L', Ƚ: 'L', ƚ: 'L', Ɲ: 'N', ɲ: 'N', Ƞ: 'N', Ɵ: 'O', Ø: 'O', ø: 'O', Ƥ: 'P', ƥ: 'P', Ᵽ: 'P',
  Ɍ: 'R', ɍ: 'R', Ʀ: 'R', Ŧ: 'T', ŧ: 'T', Ƭ: 'T', ƭ: 'T', Ʈ: 'T', Ⱦ: 'T', Ʉ: 'U', ʉ: 'U', Ʋ: 'V', ʋ: 'V', Ʌ: 'A', ʌ: 'A', Ⱥ: 'A',
  Ƴ: 'Y', ƴ: 'Y', Ɏ: 'Y', ɏ: 'Y', Ƶ: 'Z', ƶ: 'Z', Ȥ: 'Z', ȥ: 'Z',
  // currency signs drawn as letters ("USD₮")
  '₮': 'T', '₳': 'A', '₿': 'B', '₵': 'C', '₦': 'N', '₱': 'P', '€': 'E',
  // digits that pass for letters in a symbol
  '0': 'O', '1': 'I',
};

/**
 * A name's "skeleton": NFKC (which turns fullwidth and mathematical letters into plain ones), invisible and combining
 * characters removed, look-alike letters folded to Latin, upper case, and everything but letters and digits dropped.
 * Two names with the same skeleton look the same to a person.
 */
export function skeleton(text: string | null | undefined): string {
  if (!text) return '';
  return [...text.normalize('NFKD').replace(UNSAFE_CHARS, '').normalize('NFKC')]
    .map((c) => CONFUSABLE[c] ?? c)
    .join('')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I');
}

/** Symbols of tokens people already know, which an unlisted address may not take without a warning. */
export const RESERVED_SYMBOLS: readonly string[] = ['ACT', 'USDC', 'USDT', 'DAI', 'USDG', 'SOL', 'WSOL', 'ETH', 'WETH', 'BTC', 'WBTC', 'BTCB', 'CBBTC', 'BNB', 'WBNB', 'POL', 'MATIC', 'WMATIC', 'WPOL', 'ARETIA'];
/** Names (and words inside names) of the same, as skeletons. */
const RESERVED_NAMES: readonly string[] = ['USDCOIN', 'TETHER', 'TETHERUSD', 'SOLANA', 'WRAPPEDSOL', 'ETHEREUM', 'ETHER', 'WRAPPEDETHER', 'BITCOIN', 'WRAPPEDBITCOIN', 'WRAPPEDBTC', 'BINANCECOIN', 'WRAPPEDBNB', 'POLYGON', 'ARETIACOIN', 'ARETIATOKEN'];
const RESERVED_SYMBOL_SKELETONS = new Set(RESERVED_SYMBOLS.map(skeleton));
const RESERVED_NAME_SKELETONS = new Set(RESERVED_NAMES.map(skeleton));

/**
 * The well-known token a name or symbol claims to be, or null. "Aretia" anywhere in the name counts, since only Aretia's own
 * token may carry it. The caller decides whether the address is that token's (see `knownTokenAddress`).
 */
export function reservedNameClaim(symbol: string | null | undefined, name: string | null | undefined): string | null {
  const s = skeleton(symbol);
  const n = skeleton(name);
  if (RESERVED_SYMBOL_SKELETONS.has(s)) return RESERVED_SYMBOLS.find((r) => skeleton(r) === s) ?? s;
  if (RESERVED_NAME_SKELETONS.has(n) || RESERVED_SYMBOL_SKELETONS.has(n)) return n;
  if (s.includes('ARETIA') || n.includes('ARETIA')) return 'ARETIA';
  return null;
}
