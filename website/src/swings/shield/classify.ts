/**
 * What was pasted into the Shield box. Pure: it looks at the text only, never at the network.
 */
import { isSolanaAddress } from '../core/solanaTools.js';
import { hasValidChecksum } from '../core/keccak.js';

export type Classified =
  | { kind: 'solana'; value: string }
  | { kind: 'evm'; value: string; /** Mixed-case address whose EIP-55 checksum is wrong: mistyped or altered. */ badChecksum: boolean }
  | { kind: 'name'; value: string }
  | { kind: 'site'; value: string; url: URL }
  | { kind: 'transaction'; value: string }
  | { kind: 'unknown'; value: string };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{85,90}$/;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i;

/** Reads what a person pasted: an address, a name, a link, a transaction, or something Shield does not know. */
export function classifyInput(raw: string): Classified {
  const text = raw.trim();
  if (EVM_TX.test(text) || SOLANA_SIGNATURE.test(text)) return { kind: 'transaction', value: text };
  if (EVM_ADDRESS.test(text)) {
    const mixed = /[a-f]/.test(text.slice(2)) && /[A-F]/.test(text.slice(2));
    return { kind: 'evm', value: text, badChecksum: mixed && !hasValidChecksum(text) };
  }
  if (isSolanaAddress(text)) return { kind: 'solana', value: text };
  if (/^[^\s/]+\.sns$/i.test(text)) return { kind: 'name', value: text.toLowerCase() };
  const url = parseSite(text);
  if (url) return { kind: 'site', value: text, url };
  return { kind: 'unknown', value: text };
}

/** A link or a bare domain such as "app.example.com/claim", as a URL; null when it is neither. */
export function parseSite(text: string): URL | null {
  if (/\s/.test(text) || text.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : /^[^/?#@]+\.[a-z]{2,}([/?#].*)?$/i.test(text) ? `https://${text}` : null;
  if (!withScheme) return null;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // An IPv4 or IPv6 host is a valid link; a name must look like a domain.
    return url.hostname && (HOSTNAME.test(url.hostname) || /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.startsWith('[')) ? url : null;
  } catch {
    return null;
  }
}

/** The link that opens a check for this subject, kept in the page's address so a result can be shared. */
export const checkHash = (value: string): string => `#/shield/${encodeURIComponent(value)}`;

/** The reverse: what a shared link asks to check. Null for a plain "#/shield". */
export function valueFromHash(hash: string): string | null {
  const m = /^#\/shield\/(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}
