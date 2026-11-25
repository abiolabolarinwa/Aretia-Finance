import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeBase58 } from '../mi/solana/accounts.js';
import {
  cleanDescription,
  evmAbiString,
  evmAddressWord,
  impersonationProblem,
  linkProblem,
  metaplexUpdateAuthority,
  ownershipDecision,
  profileAddress,
  publicProfile,
  solanaMintAuthority,
  token2022UpdateAuthority,
  validateProfile,
} from './core.js';

const R2 = 'https://assets.aretiafinance.org';
const LOGO = `${R2}/img/${'a'.repeat(64)}.png`;
const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

describe('ownership proof', () => {
  const sol = encodeBase58(key(7));
  it('publishes at once only for a wallet the chain names as a controller', () => {
    expect(ownershipDecision('solana', `solana:${sol}`, [sol])).toBe('authority');
    expect(ownershipDecision('solana', `solana:${sol}`, [encodeBase58(key(8))])).toBe('review');
    expect(ownershipDecision('solana', `solana:${sol}`, [])).toBe('review');
  });
  it('compares Ethereum-style addresses without regard to case, Solana ones exactly', () => {
    expect(ownershipDecision('bnb', 'evm:0xabcdef0000000000000000000000000000000001', ['0xABCDEF0000000000000000000000000000000001'])).toBe('authority');
    expect(ownershipDecision('solana', `solana:${sol.toLowerCase()}`, [sol])).not.toBe('authority');
  });
  it('needs a sign-in of the token’s own family', () => {
    expect(ownershipDecision('ethereum', `solana:${sol}`, [sol])).toBe('wrong-family');
    expect(ownershipDecision('solana', 'evm:0xabcdef0000000000000000000000000000000001', ['0xabcdef0000000000000000000000000000000001'])).toBe('wrong-family');
  });

  it('reads a Solana mint authority, and none when it was given up', () => {
    const mint = new Uint8Array(82);
    mint[0] = 1;
    mint.set(key(9), 4);
    mint[44] = 6;
    mint[45] = 1;
    expect(solanaMintAuthority(mint)).toBe(encodeBase58(key(9)));
    mint[0] = 0;
    expect(solanaMintAuthority(mint)).toBeNull();
    mint[0] = 1;
    mint[45] = 0; // not initialised
    expect(solanaMintAuthority(mint)).toBeNull();
  });
  it('reads a Metaplex update authority', () => {
    const meta = new Uint8Array(100);
    meta[0] = 4;
    meta.set(key(5), 1);
    expect(metaplexUpdateAuthority(meta)).toBe(encodeBase58(key(5)));
    meta[0] = 3;
    expect(metaplexUpdateAuthority(meta)).toBeNull();
  });
  it('reads a Token-2022 metadata update authority, and none when it is all zero', () => {
    const d = new Uint8Array(166 + 4 + 80);
    d[165] = 1;
    const v = new DataView(d.buffer);
    v.setUint16(166, 19, true);
    v.setUint16(168, 80, true);
    d.set(key(3), 170);
    expect(token2022UpdateAuthority(d)).toBe(encodeBase58(key(3)));
    d.fill(0, 170, 202);
    expect(token2022UpdateAuthority(d)).toBeNull();
  });
  it('reads owner() and treats the zero address as ownership given up', () => {
    expect(evmAddressWord('0x' + '0'.repeat(24) + 'AbCdEf0000000000000000000000000000000001')).toBe('0xabcdef0000000000000000000000000000000001');
    expect(evmAddressWord('0x' + '0'.repeat(64))).toBeNull();
    expect(evmAddressWord(null)).toBeNull();
    expect(evmAddressWord('0x')).toBeNull();
    expect(evmAddressWord('0x' + 'f'.repeat(64))).toBeNull(); // not an address word
  });
  it('reads name() and symbol() in both ABI forms', () => {
    const word = (n: number): string => n.toString(16).padStart(64, '0');
    const text = Buffer.from('USDC').toString('hex');
    expect(evmAbiString('0x' + word(32) + word(4) + text.padEnd(64, '0'))).toBe('USDC');
    expect(evmAbiString('0x' + text.padEnd(64, '0'))).toBe('USDC');
    expect(evmAbiString('0x')).toBeNull();
  });
});

describe('addresses', () => {
  it('keeps Solana addresses as they are and lower-cases Ethereum-style ones', () => {
    expect(profileAddress('ethereum', '0xAbCdEf0000000000000000000000000000000001')).toEqual({ chain: 'ethereum', address: '0xabcdef0000000000000000000000000000000001' });
    expect(profileAddress('solana', 'So11111111111111111111111111111111111111112')?.address).toBe('So11111111111111111111111111111111111111112');
    expect(profileAddress('solana', '0xabcdef0000000000000000000000000000000001')).toBeNull();
    expect(profileAddress('dogechain', '0xabcdef0000000000000000000000000000000001')).toBeNull();
  });
});

describe('sanitising', () => {
  it('takes out invisible and direction-changing characters, keeps line breaks', () => {
    expect(cleanDescription('Hel​lo‮ world\r\n\r\n\r\n\r\nbye\u0000')).toBe('Hello world\n\nbye');
  });
  it('accepts a full profile and returns cleaned links', () => {
    const v = validateProfile({ description: 'A meme.', website: 'https://example.com', x: 'https://x.com/example', telegram: 'https://t.me/example', discord: 'https://discord.gg/abc', logo: LOGO });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toEqual({ description: 'A meme.', website: 'https://example.com/', x: 'https://x.com/example', telegram: 'https://t.me/example', discord: 'https://discord.gg/abc', logo: LOGO });
  });
  it('refuses an empty profile', () => {
    expect(validateProfile({}).ok).toBe(false);
  });
  it('refuses links that are not plain https', () => {
    for (const website of ['http://example.com', 'javascript:alert(1)', 'https://user:pw@example.com', 'https://127.0.0.1', 'https://localhost', 'https://example.com:8443', 'data:text/html,hi']) {
      const v = validateProfile({ website });
      expect(v.ok, website).toBe(false);
    }
  });
  it('holds each social link to its own site', () => {
    expect(validateProfile({ x: 'https://evil.com/x' }).ok).toBe(false);
    expect(validateProfile({ telegram: 'https://x.com/a' }).ok).toBe(false);
    expect(validateProfile({ discord: 'https://discord.evil.com/a' }).ok).toBe(false);
    expect(validateProfile({ discord: 'https://discord.com/invite/abc' }).ok).toBe(true);
  });
  it('refuses link shorteners, look-alike hosts, borrowed brand names and airdrop pages', () => {
    expect(linkProblem('https://bit.ly/abc')).toMatch(/shortener/);
    expect(linkProblem(new URL('https://pһantom.app/').toString())).toMatch(/look-alike/); // Cyrillic h, becomes xn--
    expect(linkProblem('https://phantom-app-connect.com/')).toMatch(/phantom/);
    expect(linkProblem('https://meta-mask.io/')).toMatch(/metamask/);
    expect(linkProblem('https://claim.mytoken.xyz/')).toMatch(/airdrop/);
    expect(linkProblem('https://mytokenairdrop.com/')).toMatch(/airdrop/);
    expect(linkProblem('https://phantom.app/')).toBeNull();
    expect(linkProblem('https://pump.fun/coin/abc')).toBeNull();
    expect(linkProblem('https://mycat.meme/')).toBeNull();
    expect(validateProfile({ website: 'https://walletconnect-sync.io' }).ok).toBe(false);
  });
  it('refuses abusive words in the description', () => {
    expect(validateProfile({ description: 'buy this n1gger coin' }).ok).toBe(false);
    expect(validateProfile({ description: 'Grapes from Scunthorpe' }).ok).toBe(true);
  });
  it('takes a logo only from Aretia’s own picture store', () => {
    expect(validateProfile({ logo: 'https://evil.com/img/' + 'a'.repeat(64) + '.png' }).ok).toBe(false);
    expect(validateProfile({ logo: `${R2}/meta/${'a'.repeat(64)}.json` }).ok).toBe(false);
    expect(validateProfile({ logo: `${R2}/img/${'a'.repeat(64)}.svg` }).ok).toBe(false);
    expect(validateProfile({ logo: LOGO }).ok).toBe(true);
  });
  it('refuses descriptions over the limit', () => {
    expect(validateProfile({ description: 'a'.repeat(501) }).ok).toBe(false);
  });
  it('drops a stored row that no longer passes the rules instead of showing it', () => {
    const row = { chain: 'bnb', address: '0xabcdef0000000000000000000000000000000001', description: 'hi', website: 'javascript:alert(1)', proof: 'authority', updated_at: 5 };
    expect(publicProfile(row)).toBeNull();
    expect(publicProfile({ ...row, website: 'https://example.com' })?.proof).toBe('authority');
  });
});

describe('impersonation', () => {
  it('refuses a profile for a token named like a well-known one at another address', () => {
    expect(impersonationProblem('ethereum', '0xabcdef0000000000000000000000000000000001', 'USDC', 'USD Coin')).toMatch(/well-known/);
    expect(impersonationProblem('ethereum', '0xabcdef0000000000000000000000000000000001', 'UЅDC', null)).toMatch(/well-known/); // Cyrillic S
    expect(impersonationProblem('ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC', 'USD Coin')).toBeNull(); // the real USDC
    expect(impersonationProblem('solana', 'So11111111111111111111111111111111111111112', 'CAT', 'Cat coin')).toBeNull();
  });
});

describe('never a ranking input', () => {
  // Profiles must not change where a token ranks: no market list, sort or score code may read them.
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  it('the market and index code never mentions profiles', () => {
    const root = process.cwd();
    const files = [...walk(join(root, 'src', 'swings', 'market')), ...walk(join(root, 'src', 'swings', 'mi')), ...readdirSync(join(root, 'api')).filter((f) => /^_(swingsMarket|marketIndexer)/.test(f)).map((f) => join(root, 'api', f))].filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/token_profiles|profiles\/core|_tokenProfiles/);
  });
  it('there is no price or payment anywhere in the feature', () => {
    for (const f of [join(process.cwd(), 'src', 'swings', 'profiles', 'core.ts'), join(process.cwd(), 'api', '_tokenProfiles.ts'), join(process.cwd(), 'supabase', 'migrations', '0027_token_profiles.sql')])
      expect(readFileSync(f, 'utf8')).not.toMatch(/\b(price_|paid_|payment_id|amount_usd|fee_)\w*/i);
  });
});
