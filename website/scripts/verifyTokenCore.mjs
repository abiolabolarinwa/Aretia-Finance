// The pure part of the "Verified by Aretia" check script: reading a Solana mint's powers and scanning Ethereum-style token code.
// No network, no files, no keys. See verify-token.mjs for the reading, and docs/verified-badge.md for what the results mean.

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Token-2022 extension types that let someone other than the holder move or block tokens, or take a cut. */
export const RISKY_EXTENSIONS = new Map([
  [1, 'transfer fee'],
  [4, 'confidential-transfer fee'],
  [9, 'non-transferable'],
  [12, 'permanent delegate'],
  [14, 'transfer hook'],
  [6, 'default account state (frozen by default)'],
  [10, 'interest-bearing (display only)'],
  [11, 'close authority'],
]);
const FLAG_ONLY = new Set([10]);

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
  for (const t of mint.extensions) {
    if (FLAG_ONLY.has(t)) continue;
    if (RISKY_EXTENSIONS.has(t)) problems.push(`the mint has the "${RISKY_EXTENSIONS.get(t)}" extension`);
  }
  const powersGivenUp = problems.length === 0 ? { pass: true, detail: 'No freeze authority, and none of the transfer-fee, delegate, hook or default-frozen extensions.' } : { pass: false, detail: `Not given up: ${problems.join('; ')}.` };
  return { supplyFixed, powersGivenUp };
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

/**
 * The two automated checks for an Ethereum-style token, from its code and its total supply read twice (a block apart is enough).
 * This is a scan, not a proof: code can hide a power. It is a gate before the human review, never a replacement for it.
 */
export function checkEvm(codeHex, supplyBefore, supplyAfter) {
  if (typeof codeHex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(codeHex) || codeHex.length < 4) {
    const fail = { pass: false, detail: 'There is no contract at that address on this chain.' };
    return { supplyFixed: fail, powersGivenUp: fail };
  }
  const found = EVM_SELECTORS.filter(([sel]) => hasSelector(codeHex, sel)).map(([, name]) => name);
  const mintLike = found.filter((n) => n.startsWith('mint'));
  const supplyFixed =
    mintLike.length > 0
      ? { pass: false, detail: `The code has ${mintLike.join(', ')}.` }
      : supplyBefore === null || supplyAfter === null
        ? { pass: false, detail: 'Could not read the total supply.' }
        : supplyBefore !== supplyAfter
          ? { pass: false, detail: 'The total supply changed between two reads.' }
          : { pass: true, detail: `No mint function found in the code. Total supply ${supplyAfter} (smallest units), unchanged between two reads.` };
  const others = found.filter((n) => !n.startsWith('mint'));
  const powersGivenUp = others.length === 0 ? { pass: true, detail: 'No pause, owner, ownership-transfer or blacklist functions found in the code.' } : { pass: false, detail: `The code has ${others.join(', ')}.` };
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
