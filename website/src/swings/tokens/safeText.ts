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
 * Look-alike letters from other alphabets (Cyrillic, Armenian, Cherokee, Greek) are how a scam token passes for a real
 * one: the top pool of a busy network can be a "USDT" spelled with Armenian and Cherokee letters. Names containing them
 * are hidden. Names entirely in another writing system (Chinese, Korean, Arabic and so on) are not touched.
 */
const LOOKALIKE = /[Ͱ-ϿЀ-ԯ԰-֏Ꭰ-᏿ᲀ-᲏Ⲁ-⳿]/;

export function hasLookalikeLetters(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && LOOKALIKE.test(t));
}

/** True if a name or symbol should be kept off the lists: abusive, or dressed up with look-alike letters. */
export function isUnsafeName(...texts: (string | null | undefined)[]): boolean {
  return isOffensive(...texts) || hasLookalikeLetters(...texts);
}
