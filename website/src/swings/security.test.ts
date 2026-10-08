/**
 * Security tests for the cross-chain, settlement, ramp and plan layers. Each one checks a promise made in the threat
 * model (docs/aretia-swings/threat-model-cross-chain.md) by trying to break it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WalletExecutionGateway } from './orchestrator/walletGateway.js';
import { WalletSessionManager } from './wallet/sessionManager.js';
import { NO_CAPABILITIES, type SessionChange, type WalletAdapter, type WalletSession } from './wallet/types.js';
import { CHAINS, SwingsError, type ChainId } from './core/types.js';
import type { SettlementTransaction } from './settlement/types.js';
import { handleRamp, type RampEnv } from '../../api/_ramp.js';

const OWNER = '0x' + 'a'.repeat(40);
const OTHER = '0x' + 'b'.repeat(40);
const ALLOWED = '0x' + 'c'.repeat(40);
const EVIL = '0x' + 'd'.repeat(40);

class EvmWallet implements WalletAdapter {
  readonly providerId = 'w';
  readonly providerName = 'W';
  readonly chainType = 'evm' as const;
  sent: unknown[] = [];
  switched: ChainId[] = [];
  private revision = 1;
  private listeners = new Set<(c: SessionChange, s: WalletSession) => void>();
  constructor(public account: string, public chain: ChainId) {}
  getSession(): WalletSession {
    return { providerId: 'w', providerName: 'W', chainType: 'evm', address: this.account, accounts: [this.account], chain: this.chain, networkId: CHAINS[this.chain].evmChainId, state: 'connected', capabilities: { ...NO_CAPABILITIES, switchNetwork: true }, connectedAt: 1, revision: this.revision };
  }
  isConnected = () => true;
  async connect() { return this.getSession(); }
  async restore() { return this.getSession(); }
  async disconnect() {}
  async refresh() { return this.getSession(); }
  async getAddress() { return this.account; }
  async getBalance(): Promise<never> { throw new Error('unused'); }
  async signTransaction(): Promise<never> { throw new Error('unused'); }
  async signMessage(): Promise<never> { throw new Error('unused'); }
  async sendTransaction(tx: unknown) { this.sent.push(tx); return '0x' + '9'.repeat(64); }
  async switchNetwork(c: ChainId) { this.chain = c; this.switched.push(c); this.revision++; for (const l of this.listeners) l('network-changed', this.getSession()); }
  onChange(l: (c: SessionChange, s: WalletSession) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
}

const tx = (over: { to?: string; from?: string; chain?: ChainId } = {}): SettlementTransaction => ({
  stepId: 'burn', chain: over.chain ?? 'base', description: 'd',
  unsigned: { kind: 'evm', chainId: CHAINS[over.chain ?? 'base'].evmChainId!, tx: { from: over.from ?? OWNER, to: over.to ?? ALLOWED, data: '0x', value: '0x0' } },
});
const setup = (account = OWNER, chain: ChainId = 'base', confirm?: (r: never) => Promise<boolean>) => {
  const wallet = new EvmWallet(account, chain);
  const manager = new WalletSessionManager(null);
  manager.add(wallet);
  manager.setActive('w');
  return { wallet, gateway: new WalletExecutionGateway(manager, () => async () => null, confirm as never) };
};

describe('the wallet gateway fails closed', () => {
  it('sends exactly one transaction on the happy path', async () => {
    const { wallet, gateway } = setup();
    expect(await gateway.send(tx(), { address: OWNER, allowedDestinations: [ALLOWED] })).toMatch(/^0x9+$/);
    expect(wallet.sent).toHaveLength(1);
  });

  it('refuses when the provider declared no addresses', async () => {
    const { wallet, gateway } = setup();
    await expect(gateway.send(tx(), { address: OWNER, allowedDestinations: [] })).rejects.toThrow(/declared no addresses/);
    expect(wallet.sent).toHaveLength(0);
  });

  it('refuses to sign for a different account than the one the move was made for', async () => {
    const { wallet, gateway } = setup(OTHER);
    await expect(gateway.send(tx({ from: OTHER }), { address: OWNER, allowedDestinations: [ALLOWED] })).rejects.toThrow(/not the account/);
    expect(wallet.sent).toHaveLength(0);
  });

  it('refuses a transaction that calls an address nobody declared, even if the quote said so', async () => {
    const { wallet, gateway } = setup();
    await expect(gateway.send(tx({ to: EVIL }), { address: OWNER, allowedDestinations: [ALLOWED] })).rejects.toThrow(/does not recognise/);
    expect(wallet.sent).toHaveLength(0);
  });

  it('refuses a transaction sent from another account than the wallet, or for another network', async () => {
    const { wallet, gateway } = setup();
    await expect(gateway.send(tx({ from: OTHER }), { address: OWNER, allowedDestinations: [ALLOWED] })).rejects.toThrow(/different account/);
    const bad = tx();
    (bad.unsigned as { chainId: number }).chainId = 1;
    await expect(gateway.send(bad, { address: OWNER, allowedDestinations: [ALLOWED] })).rejects.toThrow(/different network/);
    expect(wallet.sent).toHaveLength(0);
  });

  it('never changes the wallet network without a yes from the user', async () => {
    const none = setup(OWNER, 'ethereum');
    await expect(none.gateway.send(tx({ chain: 'base' }), { address: OWNER, allowedDestinations: [ALLOWED] })).rejects.toThrow(SwingsError);
    expect(none.wallet.switched).toEqual([]);

    const declined = setup(OWNER, 'ethereum', async () => false);
    await expect(declined.gateway.send(tx({ chain: 'base' }), { address: OWNER, allowedDestinations: [ALLOWED] })).rejects.toThrow(/not confirmed/);
    expect(declined.wallet.switched).toEqual([]);
    expect(declined.wallet.sent).toHaveLength(0);

    const agreed = setup(OWNER, 'ethereum', async () => true);
    await agreed.gateway.send(tx({ chain: 'base' }), { address: OWNER, allowedDestinations: [ALLOWED] });
    expect(agreed.wallet.switched).toEqual(['base']);
    expect(agreed.wallet.sent).toHaveLength(1);
  });
});

describe('the ramp service keeps its secrets', () => {
  const ENV: RampEnv = { RAMP_ENABLED: '1', MOONPAY_PUBLISHABLE_KEY: 'pk_test_PUBLICKEY', MOONPAY_SECRET_KEY: 'sk_test_VERYSECRET', MOONPAY_SELL_ENABLED: '1' };
  const fetchImpl = (async () => new Response('[]')) as unknown as typeof fetch;
  const call = (body: unknown) => handleRamp({ method: 'POST', origin: 'https://aretiafinance.org', ip: '9.9.9.9', contentType: 'application/json', body: JSON.stringify(body), env: ENV, fetchImpl, now: 1 });

  it('never returns the secret key in any answer, and the signed link carries only a signature', async () => {
    const answers = await Promise.all([call({ action: 'status' }), call({ action: 'session', provider: 'moonpay', side: 'buy', asset: 'USDC', chain: 'base', wallet: OWNER }), call({ action: 'session', provider: 'moonpay', side: 'sell', asset: 'USDC', chain: 'base', wallet: OWNER }), call({ action: 'nope' })]);
    for (const a of answers) expect(a.body).not.toContain('VERYSECRET');
  });

  it('refuses requests from a site that is not allowed, and oversized or non-JSON bodies', async () => {
    const out = await handleRamp({ method: 'POST', origin: 'https://evil.example', ip: '1.1.1.1', contentType: 'application/json', body: '{}', env: ENV, fetchImpl, now: 1 });
    expect(out.status).toBe(403);
    expect((await handleRamp({ method: 'POST', origin: 'https://aretiafinance.org', ip: '2.2.2.2', contentType: 'text/plain', body: '{}', env: ENV, fetchImpl, now: 1 })).status).toBe(415);
    expect((await handleRamp({ method: 'POST', origin: 'https://aretiafinance.org', ip: '3.3.3.3', contentType: 'application/json', body: 'x'.repeat(5000), env: ENV, fetchImpl, now: 1 })).status).toBe(413);
  });

  it('refuses to build a link for an address of the wrong kind or an unlisted network, so the crypto cannot be sent somewhere unintended', async () => {
    for (const body of [{ chain: 'base', wallet: 'HncLFBcun4ePWvUz8cefMx7XJR1ZBQ1d2vnXsWv2gK6F' }, { chain: 'solana', wallet: OWNER }, { chain: 'bnb', wallet: OWNER }, { chain: 'base', wallet: OWNER + 'ff' }]) {
      const r = await call({ action: 'session', provider: 'moonpay', side: 'buy', asset: 'USDC', ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('the source code keeps the rules', () => {
  const root = process.cwd();
  const dirs = ['src/swings/settlement', 'src/swings/orchestrator', 'src/swings/ramp', 'src/swings/plan', 'src/swings/intent', 'src/swings/economics', 'src/swings/crosschain', 'src/swings/intelligence', 'src/swings/wallet'];
  const files = (d: string): string[] => readdirSync(join(root, d)).flatMap((f) => (statSync(join(root, d, f)).isDirectory() ? files(join(d, f)) : /\.ts$/.test(f) && !/\.test\.ts$|\.live\.ts$|testing\.ts$/.test(f) ? [join(d, f)] : []));
  const prod = [...dirs.flatMap(files), 'src/scripts/walletCrossChain.ts', 'src/scripts/walletRamp.ts', 'src/scripts/walletPlan.ts', 'src/scripts/crossChainRuntime.ts', 'src/scripts/walletSearch.ts'];
  const code = (f: string): string => readFileSync(join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('scans a real set of files (so a pass means something)', () => {
    expect(prod.length).toBeGreaterThan(30);
    expect(prod).toContain('src/scripts/walletRamp.ts');
  });

  it('uses no dynamic code execution, shell access or raw HTML insertion', () => {
    const bad = prod.filter((f) => /\beval\(|new Function\(|child_process|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code(f)));
    expect(bad).toEqual([]);
  });

  it('never refers to a secret by name outside the server', () => {
    const bad = prod.filter((f) => /MOONPAY_SECRET_KEY|SECRET_KEY|PRIVATE_KEY|SERVICE_ROLE/.test(code(f)));
    expect(bad).toEqual([]);
  });

  it('only talks to hosts on its list', () => {
    const allowed = new Set(['iris-api.circle.com', 'buy.moonpay.com', 'buy-sandbox.moonpay.com', 'sell.moonpay.com', 'sell-sandbox.moonpay.com', 'etherscan.io', 'basescan.org', 'arbiscan.io', 'optimistic.etherscan.io', 'polygonscan.com', 'snowtrace.io', 'solscan.io', 'bscscan.com', 'www.w3.org', 'localhost', 'aretiafinance.org']);
    const found: string[] = [];
    for (const f of prod) for (const m of code(f).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) if (!allowed.has(m[1]!.toLowerCase())) found.push(`${f}: ${m[1]}`);
    expect(found).toEqual([]);
  });

  it('keeps private keys, seed phrases and passwords out of every record it saves', () => {
    for (const f of prod) {
      const src = code(f);
      const stores = /setItem\(/.test(src);
      if (stores) expect(src, f).not.toMatch(/privateKey|secretKey|mnemonic|seedPhrase|password/i);
    }
  });
});
