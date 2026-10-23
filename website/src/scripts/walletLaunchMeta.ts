/**
 * Token details on the Launch page, the browser side: the shared state of the picture / description / links fields (read by the
 * Solana form, the Ethereum-style form and the live preview), the uploader that sends a picture and a details file to Aretia's public
 * bucket through a one-use link, and the reader that fetches details back for the token page and Launch Box.
 * The rules are in ../swings/launchmeta/core.ts and the server in api/_swingsUpload.ts; docs/LAUNCH_ASSETS.md says how it is set up.
 * Nothing here sees a key: the wallet signs one plain sign-in message, and the file goes straight to storage.
 */
import { AccountClient, type Session, type Signer } from '../swings/account/client';
import { browserStorage } from '../swings/history.js';
import {
  EMPTY_DETAILS,
  buildMetadataJson,
  checkImage,
  hasAnyDetails,
  parseMetadataJson,
  validateDetails,
  type DetailIssue,
  type ImageType,
  type LaunchDetails,
  type TokenMeta,
} from '../swings/launchmeta/core.js';

export const NOT_SET_UP = 'Image upload is not set up yet';

// ---------------------------------------------------------------- shared state

export interface ChosenImage {
  type: ImageType;
  size: number;
  bytes: Uint8Array;
  /** A blob: link for showing the picture on this page only. */
  previewUrl: string;
}

export interface DetailsState {
  details: LaunchDetails;
  image: ChosenImage | null;
  imageProblem: string | null;
}

let state: DetailsState = { details: { ...EMPTY_DETAILS }, image: null, imageProblem: null };
/** 'text' for a typed field (nothing needs redrawing), 'image' when the picture changed. */
export type DetailsChange = 'text' | 'image';
const listeners = new Set<(kind: DetailsChange) => void>();

export const detailsState = (): DetailsState => state;
export function onDetailsChange(fn: (kind: DetailsChange) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(kind: DetailsChange): void {
  for (const fn of listeners) fn(kind);
}
export function setDetails(patch: Partial<LaunchDetails>): void {
  state = { ...state, details: { ...state.details, ...patch } };
  emit('text');
}
export function clearImage(): void {
  if (state.image) URL.revokeObjectURL(state.image.previewUrl);
  state = { ...state, image: null, imageProblem: null };
  emit('image');
}
export function resetDetails(): void {
  if (state.image) URL.revokeObjectURL(state.image.previewUrl);
  state = { details: { ...EMPTY_DETAILS }, image: null, imageProblem: null };
  emit('image');
}

/** Reads a chosen file, checks its size and first bytes, and keeps it for the form and the preview. */
export async function chooseImage(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = checkImage({ size: file.size }, bytes.slice(0, 12));
  if (!checked.ok) {
    if (state.image) URL.revokeObjectURL(state.image.previewUrl);
    state = { ...state, image: null, imageProblem: checked.message };
    return emit('image');
  }
  if (state.image) URL.revokeObjectURL(state.image.previewUrl);
  state = { ...state, imageProblem: null, image: { type: checked.type, size: file.size, bytes, previewUrl: URL.createObjectURL(new Blob([bytes as BlobPart], { type: checked.type })) } };
  emit('image');
}

export const wantsDetails = (): boolean => hasAnyDetails(state.details, state.image !== null);

// ---------------------------------------------------------------- uploader

export interface UploaderDeps {
  fetchImpl: typeof fetch;
  /** The wallet's session for uploads, signing in (one signature) when there is none. */
  session(): Promise<Session>;
  /** Calls the upload API under a session. */
  call<T>(session: Session, payload: Record<string, unknown>): Promise<T>;
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class LaunchUploader {
  private statusPromise: Promise<boolean> | null = null;
  constructor(private readonly d: UploaderDeps) {}

  /** Whether the server has uploads set up. Asked once; any failure counts as "not set up". */
  status(): Promise<boolean> {
    this.statusPromise ??= this.d
      .fetchImpl('/api/swings-upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'status' }) })
      .then(async (r) => r.ok && ((await r.json().catch(() => null)) as { enabled?: boolean } | null)?.enabled === true)
      .catch(() => false);
    return this.statusPromise;
  }

  /** Sends one file through a one-use link and answers its public address. A file that is already there is not sent again. */
  async put(request: Record<string, unknown>, bytes: Uint8Array, contentType: string): Promise<string> {
    const session = await this.d.session();
    const signed = await this.d.call<{ exists?: boolean; url: string; uploadUrl?: string; upsert?: boolean }>(session, { op: 'sign', ...request, size: bytes.length });
    if (signed.exists) return signed.url;
    if (!signed.uploadUrl) throw new Error('The picture store did not give an upload link. Try again.');
    const form = new FormData();
    form.append('cacheControl', '31536000');
    form.append('', new Blob([bytes as BlobPart], { type: contentType }));
    const res = await this.d.fetchImpl(signed.uploadUrl, { method: 'PUT', headers: signed.upsert ? { 'x-upsert': 'true' } : {}, body: form });
    if (!res.ok) throw new Error(res.status === 413 ? 'The picture store refused the file as too large.' : 'The upload did not go through. Try again.');
    return signed.url;
  }

  private async putImage(image: ChosenImage): Promise<string> {
    return this.put({ kind: 'image', contentType: image.type, sha256: await sha256Hex(image.bytes) }, image.bytes, image.type);
  }

  /** Solana: uploads the picture and the details file; answers the file's address, which becomes the token's on-chain uri. */
  async publishSolana(args: { name: string; symbol: string; details: LaunchDetails; image: ChosenImage | null }): Promise<string> {
    const imageUrl = args.image ? await this.putImage(args.image) : null;
    const file = new TextEncoder().encode(buildMetadataJson({ name: args.name, symbol: args.symbol, details: args.details, image: imageUrl, imageType: args.image?.type ?? null }));
    return this.put({ kind: 'json', sha256: await sha256Hex(file) }, file, 'application/json');
  }

  /** Ethereum-style: after the token exists, uploads the picture and the file keyed by the token's address. Only its creator is accepted. */
  async publishEvm(args: { chain: string; token: string; txHash: string; name: string; symbol: string; details: LaunchDetails; image: ChosenImage | null }): Promise<string> {
    const imageUrl = args.image ? await this.putImage(args.image) : null;
    const file = new TextEncoder().encode(buildMetadataJson({ name: args.name, symbol: args.symbol, details: args.details, image: imageUrl, imageType: args.image?.type ?? null }));
    return this.put({ kind: 'evm-meta', chain: args.chain, address: args.token, txHash: args.txHash }, file, 'application/json');
  }
}

export function createUploader(getSigner: () => Signer | null, fetchImpl: typeof fetch = (...a) => fetch(...a)): LaunchUploader {
  const account = new AccountClient(browserStorage());
  return new LaunchUploader({
    fetchImpl,
    session: async () => {
      const signer = getSigner();
      if (!signer) throw new Error('Connect your wallet to upload.');
      return account.session(signer.family, signer.address) ?? (await account.signIn(signer));
    },
    call: (session, payload) => account.call(session, payload, '/api/swings-upload'),
  });
}

/** What a person typed, checked; the issues name the field to mark. */
export function checkDetails(): { ok: true; details: LaunchDetails } | { ok: false; issues: DetailIssue[] } {
  const v = validateDetails(state.details);
  const issues: DetailIssue[] = v.ok ? [] : [...v.issues];
  if (state.imageProblem) issues.push({ field: 'image', message: state.imageProblem });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, details: (v as { ok: true; value: LaunchDetails }).value };
}

// ---------------------------------------------------------------- reading back

const metaMemo = new Map<string, Promise<TokenMeta | null>>();

/** The picture, description and links of a token, from Aretia's store. Null for none. Asked once per token per page. */
export function fetchTokenMeta(chain: string, address: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<TokenMeta | null> {
  const key = `${chain}:${address}`;
  let p = metaMemo.get(key);
  if (!p) {
    p = fetchTokenMetas(chain, [address], fetchImpl).then((m) => m.get(address) ?? null);
    metaMemo.set(key, p);
  }
  return p;
}

/** Several tokens of one chain at once (up to 20 per request). Answers the ones that have details. */
export async function fetchTokenMetas(chain: string, addresses: readonly string[], fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  for (let i = 0; i < addresses.length; i += 20) {
    const batch = addresses.slice(i, i + 20);
    try {
      const res = await fetchImpl(`/api/swings-meta?chain=${encodeURIComponent(chain)}&address=${batch.map(encodeURIComponent).join(',')}`);
      if (!res.ok) continue;
      const items = ((await res.json()) as { items?: Record<string, unknown> }).items ?? {};
      for (const a of batch) {
        // The server's answer is read again with the same strict rules before anything is shown.
        const meta = parseMetadataJson(items[a] ? { description: (items[a] as TokenMeta).description, image: (items[a] as TokenMeta).image, extensions: { website: (items[a] as TokenMeta).website, twitter: (items[a] as TokenMeta).x, telegram: (items[a] as TokenMeta).telegram } } : null);
        if (meta) out.set(a, meta);
      }
    } catch {
      // no details for this batch: the page shows what it shows without them
    }
  }
  return out;
}
