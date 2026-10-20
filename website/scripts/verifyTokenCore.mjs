// The pure part of the "Verified by Aretia" check script: reading a Solana mint's powers and scanning Ethereum-style token code.
// No network, no files, no keys. See verify-token.mjs for the reading, and docs/verified-badge.md for what the results mean.

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Token-2022's ExtensionType enum (spl-token-2022 `extension/mod.rs`). */
export const EXTENSION_NAMES = new Map([
  [0, 'uninitialized'],
  [1, 'transfer fee'],
  [2, 'transfer fee amount'],
  [3, 'mint close authority'],
  [4, 'confidential transfers'],
  [5, 'confidential transfer account'],
  [6, 'default account state'],
  [7, 'immutable owner'],
  [8, 'memo transfer'],
  [9, 'non-transferable'],
  [10, 'interest-bearing'],
  [11, 'CPI guard'],
  [12, 'permanent delegate'],
  [13, 'non-transferable account'],
  [14, 'transfer hook'],
  [15, 'transfer hook account'],
  [16, 'confidential transfer fee'],
  [17, 'confidential transfer fee amount'],
  [18, 'metadata pointer'],
  [19, 'token metadata'],
  [20, 'group pointer'],
  [21, 'token group'],
  [22, 'group member pointer'],
  [23, 'token group member'],
  [24, 'confidential mint and burn'],
  [25, 'scaled UI amount'],
  [26, 'pausable'],
  [27, 'pausable account'],
]);
/** The only extensions a verified mint may carry: the name, metadata and group labels. */
export const ALLOWED_EXTENSIONS = new Set([18, 19, 20, 21, 22, 23]);
/** Allowed, but printed for the reviewer to look at: interest-bearing changes only the displayed amount. */
export const FLAG_ONLY = new Set([10]);
export const extensionName = (t) => `${EXTENSION_NAMES.get(t) ?? 'unknown extension'} (${t})`;

const base58 = (bytes) => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
};

/**
 * Reads a mint account's powers. `owner` is the program that owns the account, `data` its bytes (Uint8Array).
 * Returns { ok:false, reason } when it is not a mint this script understands, so an unknown shape is never passed.
 */
export function readSolanaMint(owner, data) {
  if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) return { ok: false, reason: 'The account is not owned by the Token program or Token-2022.' };
  if (!(data instanceof Uint8Array) || data.length < 82 || data[45] !== 1) return { ok: false, reason: 'The account is not an initialised mint.' };
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const option = (at) => {
    const tag = v.getUint32(at, true);
    if (tag === 0) return null;
    if (tag === 1) return base58(data.subarray(at + 4, at + 36));
    return undefined;
  };
  const mintAuthority = option(0);
  const freezeAuthority = option(46);
  if (mintAuthority === undefined || freezeAuthority === undefined) return { ok: false, reason: 'The authority fields are malformed.' };
  const extensions = [];
  if (owner === TOKEN_2022_PROGRAM && data.length > 82) {
    if (data.length <= 165 || data[165] !== 1) return { ok: false, reason: 'The extension data is not a mint extension block.' };
    let at = 166;
    while (at + 4 <= data.length) {
      const type = v.getUint16(at, true);
      const len = v.getUint16(at + 2, true);
      if (type === 0 && len === 0) break;
      if (at + 4 + len > data.length) return { ok: false, reason: 'An extension runs past the end of the account.' };
      extensions.push(type);
      at += 4 + len;
    }
  }
  return { ok: true, supply: v.getBigUint64(36, true), decimals: data[44], mintAuthority, freezeAuthority, extensions, program: owner === TOKEN_2022_PROGRAM ? 'Token-2022' : 'Token' };
}

/** The two automated checks for a Solana mint. Each is { pass, detail }. */
export function checkSolana(mint) {
  if (!mint.ok) {
    const fail = { pass: false, detail: mint.reason };
    return { supplyFixed: fail, powersGivenUp: fail };
  }
  const supplyFixed = mint.mintAuthority === null ? { pass: true, detail: `Mint authority is gone. Supply is ${mint.supply} (smallest units), ${mint.decimals} decimals.` } : { pass: false, detail: `A mint authority still exists (${mint.mintAuthority}): more can be created.` };
  const problems = [];
  if (mint.freezeAuthority !== null) problems.push(`a freeze authority still exists (${mint.freezeAuthority})`);
  // An allow-list: anything that is not a name, metadata or group label fails, including types this script does not know.
  const refused = mint.extensions.filter((t) => !ALLOWED_EXTENSIONS.has(t) && !FLAG_ONLY.has(t));
  for (const t of refused) problems.push(`the mint has the "${extensionName(t)}" extension`);
  const flagged = mint.extensions.filter((t) => FLAG_ONLY.has(t));
  const flagText = flagged.length ? ` Flagged for the reviewer: ${flagged.map(extensionName).join(', ')}.` : '';
  const powersGivenUp = problems.length === 0 ? { pass: true, detail: `No freeze authority, and no extension beyond name, metadata and group labels.${flagText}` } : { pass: false, detail: `Not given up: ${problems.join('; ')}.` };
  const extensions = mint.extensions.map((t) => `${extensionName(t)}: ${ALLOWED_EXTENSIONS.has(t) ? 'allowed' : FLAG_ONLY.has(t) ? 'allowed, flagged for review' : 'NOT ALLOWED'}`);
  return { supplyFixed, powersGivenUp, extensions };
}

/** Four-byte selectors of functions that would let someone change the supply, stop transfers or keep control. */
export const EVM_SELECTORS = [
  ['40c10f19', 'mint(address,uint256)'],
  ['a0712d68', 'mint(uint256)'],
  ['1249c58b', 'mint()'],
  ['8456cb59', 'pause()'],
  ['8da5cb5b', 'owner()'],
  ['f2fde38b', 'transferOwnership(address)'],
  ['715018a6', 'renounceOwnership()'],
  ['f9f92be4', 'blacklist(address)'],
  ['44337ea1', 'addToBlacklist(address)'],
];

/** True if the code contains PUSH4 <selector>, the way a Solidity dispatcher compares it. */
export const hasSelector = (codeHex, selector) => codeHex.toLowerCase().includes('63' + selector);

const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1967_IMPL_SLOT = '360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** The storage slot an EIP-1967 proxy keeps its implementation address in (read with eth_getStorageAt). */
export const EIP1967_SLOT = '0x' + EIP1967_IMPL_SLOT;
/** Selectors of implementation() and proxiableUUID() (UUPS). */
const PROXY_SELECTORS = ['5c60da1b', '52d1902d'];

/** The implementation an EIP-1167 minimal proxy delegates to, or null when the code is not one. */
export function minimalProxyTarget(codeHex) {
  const code = String(codeHex).toLowerCase().replace(/^0x/, '');
  return code.startsWith(EIP1167_PREFIX) && code.length >= EIP1167_PREFIX.length + 40 ? '0x' + code.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40) : null;
}

/** The address in an EIP-1967 implementation slot value, or null when it is empty or malformed. */
export function slotAddress(slotHex) {
  return typeof slotHex === 'string' && /^0x[0-9a-fA-F]{64}$/.test(slotHex) && !/^0x0+$/.test(slotHex) ? '0x' + slotHex.slice(-40).toLowerCase() : null;
}

const EIP7702_PREFIX = 'ef0100';
/** The account an EIP-7702 delegation designator (0xef0100 + address) points to, or null when the code is not one. */
export function delegationTarget(codeHex) {
  const code = String(codeHex).toLowerCase().replace(/^0x/, '');
  return code.startsWith(EIP7702_PREFIX) ? '0x' + code.slice(EIP7702_PREFIX.length, EIP7702_PREFIX.length + 40) : null;
}

/**
 * The Solidity/Vyper metadata at the end of runtime code: CBOR (a map, first byte 0xa1..0xa7) whose length is the last two bytes.
 * It is data, not instructions, so the opcode walk skips it rather than reading a stray 0xf4 in a hash as DELEGATECALL.
 */
function withoutMetadata(code) {
  if (code.length < 4) return code;
  const len = Number.parseInt(code.slice(-4), 16);
  const start = code.length - 4 - len * 2;
  if (len === 0 || start < 0) return code;
  const first = Number.parseInt(code.slice(start, start + 2), 16);
  return first >= 0xa1 && first <= 0xa7 ? code.slice(0, start) : code;
}

/**
 * True if the code holds a DELEGATECALL (0xf4) opcode. Walks the code one instruction at a time and skips the immediate bytes of
 * PUSH1..PUSH32 (0x60..0x7f), so a 0xf4 inside a pushed constant is not counted. Data after the code (other than the trailing
 * metadata) is walked too: a false alarm only sends the token to the human review, a miss would pass it.
 */
export function hasDelegatecall(codeHex) {
  const code = withoutMetadata(String(codeHex).toLowerCase().replace(/^0x/, ''));
  for (let i = 0; i + 2 <= code.length; ) {
    const op = Number.parseInt(code.slice(i, i + 2), 16);
    if (op === 0xf4) return true;
    i += 2 + (op >= 0x60 && op <= 0x7f ? (op - 0x5f) * 2 : 0);
  }
  return false;
}

/** Why the code is (or may be) a proxy whose behaviour lives in another contract, or null. `implementationSlot` is the EIP-1967 slot read from the chain. */
export function proxyReason(codeHex, implementationSlot = null) {
  const code = String(codeHex).toLowerCase().replace(/^0x/, '');
  // An EIP-7702 account: its "code" is a pointer to another contract, which its owner can re-point at any time.
  const delegated = delegationTarget(codeHex);
  if (delegated) return `it is an EIP-7702 delegated account: its code runs in ${delegated}, and the account's key can change that`;
  const target = minimalProxyTarget(codeHex);
  if (target) return `it is an EIP-1167 minimal proxy: its code runs in ${target}`;
  const impl = slotAddress(implementationSlot);
  if (impl) return `it is an EIP-1967 proxy: its implementation slot points to ${impl}, which an admin may be able to change`;
  if (code.includes(EIP1967_IMPL_SLOT)) return 'its code uses the EIP-1967 implementation slot (an upgradeable proxy)';
  const sel = PROXY_SELECTORS.find((x) => hasSelector(code, x));
  if (sel) return `its code has ${sel === '5c60da1b' ? 'implementation()' : 'proxiableUUID()'} (an upgradeable proxy)`;
  // Any DELEGATECALL runs another contract's code with this token's storage: a proxy or library call the scan cannot see into.
  if (hasDelegatecall(code)) return 'its code uses DELEGATECALL (it can run code from another contract with its own storage)';
  return null;
}

/**
 * The two automated checks for an Ethereum-style token, from its code, its EIP-1967 implementation slot, and its total supply read at
 * two different blocks. This is a scan, not a proof: code can hide a power. It is a gate before the human review, never a replacement for
 * it. A proxy always fails: what it can do lives in code that may be swapped.
 */
export function checkEvm(codeHex, supplyBefore, supplyAfter, opts = {}) {
  if (typeof codeHex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(codeHex) || codeHex.length < 4) {
    const fail = { pass: false, detail: 'There is no contract at that address on this chain.' };
    return { supplyFixed: fail, powersGivenUp: fail };
  }
  const proxy = proxyReason(codeHex, opts.implementationSlot ?? null);
  const found = EVM_SELECTORS.filter(([sel]) => hasSelector(codeHex, sel)).map(([, name]) => name);
  const mintLike = found.filter((n) => n.startsWith('mint'));
  const blocks = opts.blocks ? ` (blocks ${opts.blocks[0]} and ${opts.blocks[1]})` : '';
  const supplyFixed = proxy
    ? { pass: false, detail: `Cannot be judged from this code: ${proxy}.` }
    : mintLike.length > 0
      ? { pass: false, detail: `The code has ${mintLike.join(', ')}.` }
      : supplyBefore === null || supplyAfter === null
        ? { pass: false, detail: 'Could not read the total supply at two blocks.' }
        : supplyBefore !== supplyAfter
          ? { pass: false, detail: `The total supply changed between two reads${blocks}.` }
          : { pass: true, detail: `No mint function found in the code. Total supply ${supplyAfter} (smallest units), unchanged between two reads${blocks}.` };
  const others = found.filter((n) => !n.startsWith('mint'));
  const problems = [...(proxy ? [proxy] : []), ...(others.length ? [`the code has ${others.join(', ')}`] : [])];
  const powersGivenUp = problems.length === 0 ? { pass: true, detail: 'Not a proxy, and no pause, owner, ownership-transfer or blacklist functions found in the code.' } : { pass: false, detail: `Not given up: ${problems.join('; ')}.` };
  return { supplyFixed, powersGivenUp };
}

/** The whole report as plain text: the two automated results, then the two checks a person records. */
export function renderReport({ chain, token, when, automated, notes = [] }) {
  const line = (label, r) => `  [${r.pass ? 'PASS' : 'FAIL'}] ${label}\n         ${r.detail}`;
  const out = [
    `Verified by Aretia: automated checks`,
    `Token:  ${token}`,
    `Chain:  ${chain}`,
    `Run:    ${when}`,
    ``,
    line('The supply is fixed', automated.supplyFixed),
    line('Special powers are given up', automated.powersGivenUp),
    ...(automated.extensions ? ['', `Token-2022 extensions (${automated.extensions.length}):`, ...(automated.extensions.length ? automated.extensions.map((e) => `  - ${e}`) : ['  - none'])] : []),
    ``,
    `Still to record by a person (this script cannot do these):`,
    `  [ ] The project link and creator match what was claimed`,
    `  [ ] A locked pool or curve exists`,
    ``,
    `This is a read of the chain on the day shown. It is not an audit, not an endorsement and not investment advice.`,
  ];
  if (notes.length) out.push('', 'Notes:', ...notes.map((n) => `  - ${n}`));
  return out.join('\n') + '\n';
}

export const automatedPass = (a) => a.supplyFixed.pass && a.powersGivenUp.pass;
