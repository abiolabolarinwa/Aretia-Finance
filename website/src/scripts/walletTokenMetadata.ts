/**
 * Token legitimacy: the metadata file a wallet reads to show a token's logo and description, with no network access and no keys.
 *
 * A Token-2022 token made on the Launch page stores its name, symbol and a link (`uri`) inside the mint. Wallets, explorers and
 * trackers follow that link to a small JSON file (the Metaplex token-metadata standard) to find the logo. A token whose link is empty,
 * not https or ipfs, or points at a file with no image shows up blank. This file:
 *   - builds that JSON from what a creator types, so it can be hosted anywhere (IPFS, a website) and pasted into the Launch form;
 *   - checks a JSON file someone has already hosted against the token it should describe;
 *   - says, from the mint alone, what is missing, so a pool's review screen can warn before money is spent.
 *
 * Hosting is not done here. Putting a creator's file and image on a server Aretia runs means storage, cost and moderation decisions that
 * are the owner's (docs/ARETIA_POOL_INTEGRATION.md section 3); until then the creator hosts it.
 */

export const METADATA_LIMITS = { name: 32, symbol: 10, description: 500, link: 200 } as const;

export interface MetadataInput {
  name: string;
  symbol: string;
  description: string;
  /** A direct link to the logo: https or ipfs, a PNG, JPG, WebP or GIF. */
  image: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface MetadataJson {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url?: string;
  extensions?: { website?: string; twitter?: string; telegram?: string };
  properties: { files: { uri: string; type: string }[]; category: 'image' };
}

const hasControl = (s: string): boolean => /[\u0000-\u001f\u007f]/.test(s);

/** An https or ipfs link, within the length the Launch form allows, with no control characters. */
export function isFetchableLink(value: string): boolean {
  if (value.length === 0 || value.length > METADATA_LIMITS.link || hasControl(value)) return false;
  try {
    const p = new URL(value).protocol;
    return p === 'https:' || p === 'ipfs:';
  } catch {
    return false;
  }
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** The image type from the link's extension, or null when it has none the standard lists (an IPFS link may have none: then image/png is assumed by the caller). */
export function imageTypeOf(link: string): string | null {
  try {
    const path = new URL(link).pathname.toLowerCase();
    const ext = /\.([a-z0-9]+)$/.exec(path)?.[1];
    return ext ? (IMAGE_TYPES[ext] ?? null) : null;
  } catch {
    return null;
  }
}

export type BuiltMetadata = { ok: true; json: MetadataJson; text: string } | { ok: false; problems: string[] };

/** Builds the metadata file, or says exactly what to fix. The text is stable (two-space JSON, trailing newline) so its hash is repeatable. */
export function buildMetadataJson(i: MetadataInput): BuiltMetadata {
  const problems: string[] = [];
  const name = i.name.trim();
  const symbol = i.symbol.trim();
  const description = i.description.trim();
  if (name === '' || [...name].length > METADATA_LIMITS.name || hasControl(name)) problems.push(`The name must be 1 to ${METADATA_LIMITS.name} characters.`);
  if (symbol === '' || [...symbol].length > METADATA_LIMITS.symbol || hasControl(symbol)) problems.push(`The symbol must be 1 to ${METADATA_LIMITS.symbol} characters.`);
  if ([...description].length > METADATA_LIMITS.description || hasControl(description.replace(/\n/g, ' '))) problems.push(`The description can be at most ${METADATA_LIMITS.description} characters.`);
  if (!isFetchableLink(i.image)) problems.push('The logo must be a direct https or ipfs link.');
  const type = imageTypeOf(i.image) ?? (i.image.startsWith('ipfs:') ? 'image/png' : null);
  if (isFetchableLink(i.image) && type === null) problems.push('The logo link must end in .png, .jpg, .webp or .gif (an ipfs link may have no extension).');
  const optional = (label: string, v: string | undefined): string | undefined => {
    const t = (v ?? '').trim();
    if (t === '') return undefined;
    if (!isFetchableLink(t)) problems.push(`${label} must be an https link.`);
    return t;
  };
  const website = optional('The website', i.website);
  const twitter = optional('The X (Twitter) link', i.twitter);
  const telegram = optional('The Telegram link', i.telegram);
  if (problems.length > 0) return { ok: false, problems };
  const json: MetadataJson = {
    name,
    symbol,
    description,
    image: i.image,
    ...(website ? { external_url: website } : {}),
    ...(website || twitter || telegram ? { extensions: { ...(website ? { website } : {}), ...(twitter ? { twitter } : {}), ...(telegram ? { telegram } : {}) } } : {}),
    properties: { files: [{ uri: i.image, type: type! }], category: 'image' },
  };
  return { ok: true, json, text: `${JSON.stringify(json, null, 2)}\n` };
}

/** What the mint says about itself (from `parseMintAccount`), or null when the token has no metadata. */
export interface MintMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/**
 * What is missing from a token's metadata, judged from the mint alone (no network): plain-language notes for a review screen.
 * Empty means the link looks usable; it does not mean the file behind it exists (that is `checkMetadataFile`).
 */
export function metadataNotes(meta: MintMetadata | null): string[] {
  if (meta === null) return ['This token has no name or symbol stored on it, so wallets will show it as an unnamed token.'];
  const notes: string[] = [];
  if (meta.uri.trim() === '') notes.push('This token has no metadata link, so wallets, explorers and trackers will show it with no logo or description.');
  else if (!isFetchableLink(meta.uri)) notes.push('This token’s metadata link is not an https or ipfs link, so most wallets will not load its logo.');
  return notes;
}

/** Checks a metadata file that was fetched from a token's link against the token it should describe. Returns what is wrong. */
export function checkMetadataFile(file: unknown, token: { name: string; symbol: string }): string[] {
  if (typeof file !== 'object' || file === null) return ['The link does not lead to a JSON metadata file.'];
  const f = file as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof f.image !== 'string' || !isFetchableLink(f.image)) problems.push('The file has no usable logo: its "image" must be an https or ipfs link.');
  if (typeof f.name !== 'string' || f.name !== token.name) problems.push('The name in the file is not the token’s name.');
  if (typeof f.symbol !== 'string' || f.symbol !== token.symbol) problems.push('The symbol in the file is not the token’s symbol.');
  if (typeof f.description !== 'string' || f.description.trim() === '') problems.push('The file has no description.');
  return problems;
}
