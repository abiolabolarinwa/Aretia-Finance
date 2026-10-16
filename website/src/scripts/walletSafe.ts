/**
 * The Aretia Safe page of the wallet. A Safe is a smart account that needs several signers to approve a transaction.
 *
 * What this page does today: it READS a vault straight from the chain (public node, no wallet needed) and says plainly what it
 * found: who the signers are, how many must approve, the version, whether any module is installed, and whether the contract
 * behind it is the standard Safe v1.4.1 one. It holds no keys, signs nothing and sends nothing.
 *
 * Creating a vault, proposing and signing transactions, Bunker Mode, Recovery Guardian and Legacy are in the Aretia browser
 * extension (testnet, unaudited). Only the signer threshold is enforced by the Safe contract; nothing here changes that.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';
import { decodeAbiString, publicRead, PUBLIC_EVM_RPC, type EvmRead } from '../swings/chains/evmSession.js';

/** The canonical Safe v1.4.1 implementations (safe-global/safe-deployments). The proxy's first storage slot points at one of them. */
export const SAFE_SINGLETONS: Readonly<Record<string, string>> = {
  '0x41675c099f32341bf84bfc5382af534df5c7461a': 'Safe v1.4.1',
  '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': 'Safe v1.4.1 (L2)',
};
export const SUPPORTED_VERSION = '1.4.1';

const SEL = {
  getOwners: '0xa0e67e2b',
  getThreshold: '0xe75235b8',
  nonce: '0xaffed0e0',
  VERSION: '0xffa1ad74',
  // getModulesPaginated(address start, uint256 pageSize): start at the list head (0x…01), up to 10 modules.
  modules: `0xcc2f8452${'1'.padStart(64, '0')}${'a'.padStart(64, '0')}`,
} as const;

export interface SafeReadback {
  address: string;
  owners: string[];
  threshold: number;
  nonce: number;
  version: string;
  modules: string[];
  /** The implementation the proxy points at, lower case, or null when it could not be read. */
  singleton: string | null;
}

export type SafeRead = { status: 'ok'; safe: SafeReadback } | { status: 'no-contract' } | { status: 'not-a-safe'; reason: string };

export const isEvmAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

const isHex = (v: unknown): v is string => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);
const word = (hex: string, index: number): string => hex.slice(2 + index * 64, 2 + (index + 1) * 64);
const toAddress = (w: string): string => `0x${w.slice(24)}`.toLowerCase();

/** Decodes an `address[]` whose offset word is at `headIndex`; null if the data is malformed. */
function decodeAddressArray(hex: string, headIndex: number): string[] | null {
  const offset = Number.parseInt(word(hex, headIndex).slice(-8), 16);
  if (!Number.isFinite(offset) || offset % 32 !== 0) return null;
  const at = offset / 32;
  const length = Number.parseInt(word(hex, at).slice(-8), 16);
  if (!Number.isFinite(length) || length > 256 || hex.length < 2 + (at + 1 + length) * 64) return null;
  const out: string[] = [];
  for (let i = 0; i < length; i++) out.push(toAddress(word(hex, at + 1 + i)));
  return out;
}

const toSmallInt = (hex: unknown): number | null => {
  if (!isHex(hex) || hex.length < 66) return null;
  const n = BigInt(`0x${word(hex, 0)}`);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
};

/** Reads a Safe from the chain. Every field comes from the chain; nothing is assumed. */
export async function readSafeVault(read: EvmRead, address: string): Promise<SafeRead> {
  const to = address.toLowerCase();
  const code = await read('eth_getCode', [to, 'latest']);
  if (!isHex(code) || code === '0x') return { status: 'no-contract' };
  const call = async (data: string): Promise<unknown> => {
    try {
      return await read('eth_call', [{ to, data }, 'latest']);
    } catch (e) {
      // A contract that is not a Safe reverts these calls; only that case means "not a Safe". A node failure must surface.
      if (e instanceof Error && /revert|execution|invalid opcode|out of gas/i.test(e.message)) return null;
      throw e;
    }
  };
  const [ownersHex, thresholdHex, nonceHex, versionHex, modulesHex, slot0] = await Promise.all([
    call(SEL.getOwners),
    call(SEL.getThreshold),
    call(SEL.nonce),
    call(SEL.VERSION),
    call(SEL.modules),
    read('eth_getStorageAt', [to, '0x0', 'latest']),
  ]);
  const owners = isHex(ownersHex) ? decodeAddressArray(ownersHex, 0) : null;
  const threshold = toSmallInt(thresholdHex);
  const nonce = toSmallInt(nonceHex);
  const version = decodeAbiString(versionHex);
  if (!owners || owners.length === 0 || threshold === null || nonce === null || !version)
    return { status: 'not-a-safe', reason: 'It has code, but it does not answer like a Safe (no signer list, threshold, nonce or version).' };
  if (threshold < 1 || threshold > owners.length) return { status: 'not-a-safe', reason: 'It reports a threshold that its signer list cannot meet.' };
  const modules = isHex(modulesHex) ? (decodeAddressArray(modulesHex, 0) ?? []) : [];
  const singleton = isHex(slot0) && slot0.length >= 66 ? toAddress(word(slot0, 0)) : null;
  return { status: 'ok', safe: { address: to, owners, threshold, nonce, version, modules, singleton } };
}

export type Tone = 'on' | 'warn' | 'off';
export interface SafeJudgement {
  tone: Tone;
  headline: string;
  notes: string[];
}

/** What a person should take from the readback. It never says "safe to use": it says what was and was not found. */
export function judgeSafe(safe: SafeReadback): SafeJudgement {
  const notes: string[] = [];
  let tone: Tone = 'on';
  const warn = (text: string): void => {
    tone = 'warn';
    notes.push(text);
  };
  const impl = safe.singleton ? SAFE_SINGLETONS[safe.singleton] : undefined;
  if (!safe.singleton) warn('The contract behind this vault could not be read, so it is not confirmed to be the standard Safe contract.');
  else if (!impl) warn('This vault points at a contract that is not a known Safe v1.4.1 release. Do not rely on it until you have checked what it is.');
  if (safe.version !== SUPPORTED_VERSION) warn(`It reports Safe version ${safe.version}. The Aretia extension supports ${SUPPORTED_VERSION} only.`);
  if (safe.modules.length > 0)
    warn(`${safe.modules.length} module${safe.modules.length === 1 ? ' is' : 's are'} enabled. A module can move funds without the signers' approval, so read what each one does.`);
  if (safe.threshold === 1 && safe.owners.length > 1) warn('Only one approval is needed, so any single signer can move the funds.');
  if (safe.owners.length - safe.threshold === 0) notes.push('Every signer must approve. If one key is lost, nothing can be moved again.');
  if (tone === 'on') notes.unshift('The contract is the standard Safe v1.4.1 one and no module is installed.');
  return {
    tone,
    headline: tone === 'on' ? `${safe.threshold} of ${safe.owners.length} signers must approve` : `${safe.threshold} of ${safe.owners.length} signers must approve, with points to check`,
    notes,
  };
}

const shortAddress = (a: string): string => `${a.slice(0, 8)}…${a.slice(-6)}`;

function node(tag: string, text?: string, className?: string): HTMLElement {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
}

function row(label: string, value: string, mono = false): HTMLElement {
  const wrap = node('div');
  wrap.append(node('dt', label), node('dd', value, mono ? 'wapp-mono' : undefined));
  return wrap;
}

function render(target: HTMLElement, chain: ChainId, result: SafeRead): void {
  target.textContent = '';
  if (result.status === 'no-contract') {
    target.append(node('p', `There is no contract at that address on ${CHAINS[chain].name}. It is not a Safe vault there. Check the network and the address.`, 'wapp__banner wapp__banner--warn'));
    return;
  }
  if (result.status === 'not-a-safe') {
    target.append(node('p', result.reason, 'wapp__banner wapp__banner--warn'));
    return;
  }
  const { safe } = result;
  const verdict = judgeSafe(safe);
  target.append(node('span', verdict.headline, `wapp__state wapp__state--${verdict.tone}`));
  const list = node('ul', undefined, 'wapp__list');
  for (const n of verdict.notes) list.append(node('li', n));
  target.append(list);
  const rows = node('dl', undefined, 'wapp__rows');
  rows.append(
    row('Network', CHAINS[chain].name),
    row('Vault', safe.address, true),
    row('Approvals needed', `${safe.threshold} of ${safe.owners.length}`),
    row('Version', safe.version),
    row('Contract', (safe.singleton && SAFE_SINGLETONS[safe.singleton]) || (safe.singleton ? `Unrecognised (${shortAddress(safe.singleton)})` : 'Not read')),
    row('Modules', safe.modules.length === 0 ? 'None' : safe.modules.map(shortAddress).join(', ')),
    row('Transactions executed', String(safe.nonce)),
  );
  target.append(rows);
  target.append(node('span', 'Signers', 'wapp__eyebrow'));
  const signers = node('ul', undefined, 'wapp__list');
  for (const o of safe.owners) signers.append(node('li', o, 'wapp-mono'));
  target.append(signers);
}

export function initSafe(): void {
  const pane = document.querySelector<HTMLElement>('[data-pane="safe"]');
  if (!pane) return;
  const select = pane.querySelector<HTMLSelectElement>('[data-safe-chain]');
  const input = pane.querySelector<HTMLInputElement>('[data-safe-address]');
  const button = pane.querySelector<HTMLButtonElement>('[data-safe-read]');
  const out = pane.querySelector<HTMLElement>('[data-safe-result]');
  if (!select || !input || !button || !out) return;
  for (const info of Object.values(CHAINS)) {
    if (info.kind !== 'evm' || !(info.id in PUBLIC_EVM_RPC)) continue;
    const option = document.createElement('option');
    option.value = info.id;
    option.textContent = info.name;
    select.append(option);
  }
  let run = 0;
  const go = async (): Promise<void> => {
    const address = input.value.trim();
    out.textContent = '';
    if (!isEvmAddress(address)) {
      out.append(node('p', 'Enter a vault address: 0x followed by 40 letters and digits.', 'wapp__banner wapp__banner--warn'));
      return;
    }
    const chain = select.value as ChainId;
    const mine = ++run;
    button.disabled = true;
    out.append(node('p', 'Reading the vault from the network…', 'wapp__fine'));
    try {
      const result = await readSafeVault(publicRead(chain), address);
      if (mine === run) render(out, chain, result);
    } catch (e) {
      if (mine !== run) return;
      out.textContent = '';
      out.append(node('p', e instanceof Error ? e.message : 'The network could not be read. Try again in a moment.', 'wapp__banner wapp__banner--warn'));
    } finally {
      if (mine === run) button.disabled = false;
    }
  };
  button.addEventListener('click', () => void go());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void go();
  });
}
