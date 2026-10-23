/**
 * Token details for Aretia Launch: a picture, a description and three links (website, X, Telegram), the JSON file that carries them,
 * and the rules for uploading that file and the picture. Pure: no network, no page, no keys. Used by the Launch page (to check what
 * a person typed and to build the file), by the server (to decide whether to hand out an upload slot) and by the token page and
 * Launch Box (to read the file back safely).
 *
 * Where things live: a public Supabase Storage bucket the owner creates (docs/LAUNCH_ASSETS.md).
 *   img/<sha256>.<png|jpg|gif>   the picture, named by the SHA-256 of its bytes
 *   meta/<sha256>.json           the metadata JSON of a Solana token, named by the SHA-256 of its bytes (its URL is the token's on-chain uri)
 *   evm/<chain>/<address>.json   the metadata JSON of an Ethereum-style token, keyed by the token's address (the token has no uri)
 * A file is never overwritten: the first upload to a path wins.
 */

export const IMAGE_RULES = {
  types: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' } as Readonly<Record<string, string>>,
  maxBytes: 15 * 1024 * 1024,
} as const;
export const JSON_MAX_BYTES = 4096;

export const DETAIL_LIMITS = { descriptionMax: 500, urlMax: 120 } as const;

export interface LaunchDetails {
  description: string;
  website: string;
  x: string;
  telegram: string;
}
export const EMPTY_DETAILS: LaunchDetails = { description: '', website: '', x: '', telegram: '' };

export interface DetailIssue {
  field: keyof LaunchDetails | 'image';
  message: string;
}

const hasControl = (text: string, allowNewline = false): boolean =>
  [...text].some((c) => {
    const n = c.charCodeAt(0);
    if (allowNewline && n === 10) return false;
    return n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029;
  });

const HOSTS = {
  x: ['x.com', 'twitter.com'],
  telegram: ['t.me', 'telegram.me'],
} as const;

/** A plain https link: no credentials, a real host name (not an address or "localhost"), at most `urlMax` characters. Returns the cleaned link or null. */
export function cleanHttpsUrl(text: string, hosts?: readonly string[]): string | null {
  const t = text.trim();
  if (t.length === 0 || t.length > DETAIL_LIMITS.urlMax || /\s/.test(t) || hasControl(t)) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+)+$/.test(host)) return null;
  if (hosts && !hosts.some((h) => host === h || host === `www.${h}`)) return null;
  const out = u.toString();
  return out.length <= DETAIL_LIMITS.urlMax ? out : null;
}

export type DetailsValidation = { ok: true; value: LaunchDetails } | { ok: false; issues: DetailIssue[] };

/** Checks what a person typed. Every field is optional; a field left empty stays empty. */
export function validateDetails(input: LaunchDetails): DetailsValidation {
  const issues: DetailIssue[] = [];
  const description = input.description.replace(/\r\n?/g, '\n').trim();
  if (description.length > DETAIL_LIMITS.descriptionMax || hasControl(description, true))
    issues.push({ field: 'description', message: `At most ${DETAIL_LIMITS.descriptionMax} characters, plain text.` });
  const out: LaunchDetails = { description, website: '', x: '', telegram: '' };
  const links: [keyof Pick<LaunchDetails, 'website' | 'x' | 'telegram'>, string, readonly string[] | undefined][] = [
    ['website', 'An https:// link to your website.', undefined],
    ['x', 'An https://x.com/… link.', HOSTS.x],
    ['telegram', 'An https://t.me/… link.', HOSTS.telegram],
  ];
  for (const [field, message, hosts] of links) {
    const raw = input[field].trim();
    if (raw === '') continue;
    const clean = cleanHttpsUrl(raw, hosts);
    if (clean === null) issues.push({ field, message: `${message} Up to ${DETAIL_LIMITS.urlMax} characters.` });
    else out[field] = clean;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
}

export const hasAnyDetails = (d: LaunchDetails, hasImage: boolean): boolean => hasImage || d.description !== '' || d.website !== '' || d.x !== '' || d.telegram !== '';

// ---------------------------------------------------------------- pictures

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif';

/** The type of a picture from its first bytes, or null. A file's name or declared type is not trusted. */
export function sniffImageType(head: Uint8Array): ImageType | null {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && String.fromCharCode(...head.slice(0, 6)).match(/^GIF8[79]a$/)) return 'image/gif';
  return null;
}

/** Checks a chosen file by its size and its first bytes. */
export function checkImage(file: { size: number }, head: Uint8Array): { ok: true; type: ImageType } | { ok: false; message: string } {
  if (file.size <= 0) return { ok: false, message: 'That file is empty.' };
  if (file.size > IMAGE_RULES.maxBytes) return { ok: false, message: `That picture is over ${IMAGE_RULES.maxBytes / 1024 / 1024} MB.` };
  const type = sniffImageType(head);
  return type ? { ok: true, type } : { ok: false, message: 'Use a JPG, PNG or GIF picture.' };
}

// ---------------------------------------------------------------- the metadata file

export interface MetadataInput {
  name: string;
  symbol: string;
  details: LaunchDetails;
  /** The public URL of the uploaded picture, or null for none. */
  image: string | null;
  imageType: ImageType | null;
}

/**
 * The JSON file a wallet or explorer reads: the usual name / symbol / description / image fields, the picture again under
 * properties.files, and the links under extensions. Only fields with a value appear. The text is fixed, so the same input always
 * gives the same bytes (and the same hash).
 */
export function buildMetadataJson(input: MetadataInput): string {
  const o: Record<string, unknown> = { name: input.name, symbol: input.symbol };
  if (input.details.description) o.description = input.details.description;
  if (input.image) {
    o.image = input.image;
    o.properties = { category: 'image', files: [{ uri: input.image, type: input.imageType ?? 'image/png' }] };
  }
  if (input.details.website) o.external_url = input.details.website;
  const ext: Record<string, string> = {};
  if (input.details.website) ext.website = input.details.website;
  if (input.details.x) ext.twitter = input.details.x;
  if (input.details.telegram) ext.telegram = input.details.telegram;
  if (Object.keys(ext).length > 0) o.extensions = ext;
  return JSON.stringify(o);
}

/** Where a bucket's public files are read from. */
export const publicUrl = (supabaseBase: string, bucket: string, path: string): string => `${supabaseBase.replace(/\/+$/, '')}/storage/v1/object/public/${bucket}/${path}`;

/** True for a link to a public Supabase Storage file. Pictures and files are shown only from there, never from an address a stranger chose. */
export function isTrustedAssetUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 300) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/.test(u.hostname) && u.port === '' && u.username === '' && u.pathname.startsWith('/storage/v1/object/public/') && u.search === '';
  } catch {
    return false;
  }
}

export interface TokenMeta {
  description: string;
  image: string | null;
  website: string | null;
  x: string | null;
  telegram: string | null;
}

/** Reads a metadata file back, keeping only what is safe to show. Anything else in it is ignored. */
export function parseMetadataJson(input: unknown): TokenMeta | null {
  let v: unknown = input;
  if (typeof input === 'string') {
    if (input.length > JSON_MAX_BYTES * 4) return null;
    try {
      v = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const ext = typeof o.extensions === 'object' && o.extensions !== null && !Array.isArray(o.extensions) ? (o.extensions as Record<string, unknown>) : {};
  const link = (x: unknown, hosts?: readonly string[]): string | null => (typeof x === 'string' ? cleanHttpsUrl(x, hosts) : null);
  const desc = typeof o.description === 'string' ? o.description.replace(/\r\n?/g, '\n').trim() : '';
  return {
    description: desc.length <= DETAIL_LIMITS.descriptionMax && !hasControl(desc, true) ? desc : '',
    image: isTrustedAssetUrl(o.image) ? o.image : null,
    website: link(ext.website ?? o.external_url),
    x: link(ext.twitter, HOSTS.x),
    telegram: link(ext.telegram, HOSTS.telegram),
  };
}

export const hasMeta = (m: TokenMeta | null): m is TokenMeta => m !== null && (m.description !== '' || m.image !== null || m.website !== null || m.x !== null || m.telegram !== null);

// ---------------------------------------------------------------- upload policy

export const EVM_META_CHAINS = ['bnb', 'ethereum', 'polygon'] as const;
export type EvmMetaChain = (typeof EVM_META_CHAINS)[number];

export type UploadRequest =
  | { kind: 'image'; contentType: string; size: number; sha256: string }
  | { kind: 'json'; size: number; sha256: string }
  | { kind: 'evm-meta'; chain: EvmMetaChain; address: string; size: number };

export type UploadPlan = { ok: true; path: string; contentType: string; immutableName: boolean } | { ok: false; message: string };

const SHA = /^[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** What may be uploaded, and where it goes. The server runs this on every request; the page runs it first so it never asks for what would be refused. */
export function planUpload(raw: unknown): UploadPlan {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const size = r.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return { ok: false, message: 'The file size is missing.' };
  if (r.kind === 'image') {
    const ext = typeof r.contentType === 'string' ? IMAGE_RULES.types[r.contentType] : undefined;
    if (!ext) return { ok: false, message: 'Use a JPG, PNG or GIF picture.' };
    if (size > IMAGE_RULES.maxBytes) return { ok: false, message: `That picture is over ${IMAGE_RULES.maxBytes / 1024 / 1024} MB.` };
    if (typeof r.sha256 !== 'string' || !SHA.test(r.sha256)) return { ok: false, message: 'The picture’s hash is missing.' };
    return { ok: true, path: `img/${r.sha256}.${ext}`, contentType: r.contentType as string, immutableName: true };
  }
  if (r.kind === 'json') {
    if (size > JSON_MAX_BYTES) return { ok: false, message: 'The details file is too large.' };
    if (typeof r.sha256 !== 'string' || !SHA.test(r.sha256)) return { ok: false, message: 'The file’s hash is missing.' };
    return { ok: true, path: `meta/${r.sha256}.json`, contentType: 'application/json', immutableName: true };
  }
  if (r.kind === 'evm-meta') {
    if (size > JSON_MAX_BYTES) return { ok: false, message: 'The details file is too large.' };
    if (typeof r.chain !== 'string' || !(EVM_META_CHAINS as readonly string[]).includes(r.chain)) return { ok: false, message: 'That network has no token details yet.' };
    if (typeof r.address !== 'string' || !EVM_ADDRESS.test(r.address)) return { ok: false, message: 'The token address is not valid.' };
    return { ok: true, path: `evm/${r.chain}/${r.address.toLowerCase()}.json`, contentType: 'application/json', immutableName: false };
  }
  return { ok: false, message: 'Unknown kind of file.' };
}

/** Uploads one wallet may ask for per hour, in total. */
export const UPLOAD_LIMITS = { perOwnerPerHour: 12, perIpPerHour: 40 } as const;
