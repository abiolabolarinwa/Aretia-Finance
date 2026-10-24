import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALLOWED_FEE_BPS, ARETIA_POOL_FEE_ADDRESS, ARETIA_POOL_FEE_LAMPORTS, ARETIA_POOL_PROGRAM_ID_DEVNET, ARETIA_POOL_PROGRAM_ID_MAINNET, MAX_AMOUNT, MAX_DECAY_SECS, MAX_SNIPER_BPS, MIN_LIQUIDITY, MIN_LIQUIDITY_DELTA, MIN_TOKENS, PROTOCOL_SHARE_BPS } from './walletAretiaPoolCore';
import { POOL_TRADING_FEES_BPS } from './walletPoolCore';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const program = () => read('../../../program/aretia-pool/programs/aretia-pool/src/lib.rs');
const math = () => read('../../../program/aretia-pool/pool-math/src/lib.rs');
const constant = (src: string, name: string): string => {
  const m = new RegExp(`pub const ${name}[^=]*=\\s*([^;]+);`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return m[1]!.trim();
};
const num = (text: string): bigint => BigInt(text.replace(/_/g, '').replace(/u\d+$/, '').replace(/ as u\d+/, ''));

describe('the page keeps Aretia Pool off', () => {
  it('only contains the card when built with PUBLIC_ARETIA_POOL_ENABLED=1', () => {
    const page = read('../pages/wallet/index.astro');
    const at = page.indexOf('data-aretia-pool-root');
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(page.lastIndexOf('{aretiaPoolOn', at), at)).toContain('{aretiaPoolOn && (');
    expect(page).toContain("const aretiaPoolOn = import.meta.env.PUBLIC_ARETIA_POOL_ENABLED === '1';");
  });
  it('is not turned on by any env file or build script in the repo', () => {
    const pkg = read('../../package.json');
    expect(pkg).not.toContain('PUBLIC_ARETIA_POOL_ENABLED');
  });
  it('shows a notice and draws nothing that could send while there is no mainnet program', () => {
    const card = read('./walletAretiaPool.ts');
    expect(ARETIA_POOL_PROGRAM_ID_MAINNET).toBeNull();
    expect(card).toContain("aretiaPoolProgramFor('mainnet')");
    const at = card.indexOf('if (!program) {', card.indexOf('function draw()'));
    expect(at).toBeGreaterThan(-1);
    expect(card.slice(at, at + 800)).toContain('return;');
    expect(card).toMatch(/if \(!program\) throw new Error/);
  });
  it('is wired into the page once, and only through the card file', () => {
    const app = read('./walletLaunchCluster.ts');
    expect(app.match(/initAretiaPool\(/g)).toHaveLength(1);
    expect(app).toContain("from './walletAretiaPool'");
  });
  it('is registered in Swings as DISABLED, so nothing can be routed to it', () => {
    const entries = read('../swings/dex/entries.ts');
    const at = entries.indexOf("id: 'aretia-pool'");
    expect(at).toBeGreaterThan(-1);
    const block = entries.slice(at, entries.indexOf('},', at));
    expect(block).toContain("status: 'DISABLED'");
    expect(block).not.toContain("'ACTIVE'");
  });
});

describe('the card keeps what is typed and what is sent the same', () => {
  it('redraws when any amount box is left, so the quote and the button never describe an older amount', () => {
    const card = read('./walletAretiaPool.ts');
    const at = card.indexOf('const small = (');
    expect(at).toBeGreaterThan(-1);
    const body = card.slice(at, card.indexOf('return i;', at));
    expect(body).toContain("addEventListener('input'");
    expect(body).toContain("addEventListener('change', () => draw())");
    // Found in a browser run: a change listener attached to the boxes that existed at that moment missed the ones made after it.
    expect(card).not.toMatch(/box\.querySelectorAll\('input'\)\.forEach/);
  });
});

describe('the card does not offer a sold position to its old owner', () => {
  it('shows the owner and draws no action unless the viewer owns the position', () => {
    const card = read('./walletAretiaPool.ts');
    expect(card).toContain('position.owner === host.getAddress()');
    expect(card).toContain('if (position && mine) {');
    expect(card).toContain('(not you)');
    expect(card).toContain('view.position.owner !== owner');
  });
});

describe('the web constants equal the program’s', () => {
  it('program id, fee wallet, creation fee, share, limits and fee tiers', () => {
    const src = program();
    expect(/declare_id!\("([^"]+)"\)/.exec(src)![1]).toBe(ARETIA_POOL_PROGRAM_ID_DEVNET);
    expect(/pubkey!\("([^"]+)"\)/.exec(constant(src, 'FEE_WALLET'))![1]).toBe(ARETIA_POOL_FEE_ADDRESS);
    expect(num(constant(src, 'CREATE_FEE_LAMPORTS'))).toBe(ARETIA_POOL_FEE_LAMPORTS);
    const m = math();
    expect(num(constant(m, 'PROTOCOL_SHARE_BPS'))).toBe(PROTOCOL_SHARE_BPS);
    expect(num(constant(m, 'MIN_TOKENS'))).toBe(MIN_TOKENS);
    expect(num(constant(m, 'MIN_LIQUIDITY'))).toBe(MIN_LIQUIDITY);
    expect(num(constant(m, 'MIN_LIQUIDITY_DELTA'))).toBe(MIN_LIQUIDITY_DELTA);
    expect(num(constant(m, 'MAX_SNIPER_BPS'))).toBe(BigInt(MAX_SNIPER_BPS));
    expect(num(constant(m, 'MAX_DECAY_SECS'))).toBe(BigInt(MAX_DECAY_SECS));
    expect(MAX_AMOUNT).toBe(1n << 62n);
    expect(constant(m, 'MAX_AMOUNT')).toBe('1 << 62');
    expect(/ALLOWED_FEE_BPS[^=]*=\s*\[([^\]]+)\]/.exec(m)![1]!.split(',').map((x) => Number(x.trim()))).toEqual([...ALLOWED_FEE_BPS]);
    expect([...ALLOWED_FEE_BPS]).toEqual([...POOL_TRADING_FEES_BPS]);
  });
  it('the program’s allowed extensions are the Launch page’s', () => {
    expect(/ALLOWED_EXTENSIONS: \[u16; 2\] = \[(\d+), (\d+)\]/.exec(program())!.slice(1).map(Number)).toEqual([18, 19]);
  });
  it('the program has no instruction that could change a fee, a share or a lock downward', () => {
    const src = program();
    const names = [...src.matchAll(/pub fn (\w+)(?:<'info>)?\(ctx: Context/g)].map((m) => m[1]);
    expect(names).toEqual(['create_pool', 'swap', 'add_liquidity', 'remove_liquidity', 'claim_fees', 'transfer_position', 'set_recipient', 'lock_liquidity']);
    // `locked` is only ever assigned in create_pool and lock_liquidity, and only upward.
    const assigns = [...src.matchAll(/\.locked\s*=\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(assigns).toEqual(['if lock { l0 } else { 0 }', 'locked']);
  });
});
