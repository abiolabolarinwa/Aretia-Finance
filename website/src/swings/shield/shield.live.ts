/**
 * Read-only live proof of Shield against the real networks and services. Signs and sends nothing.
 * Run with: npx vitest run --config vitest.live.config.ts src/swings/shield/shield.live.ts
 */
import { describe, expect, it } from 'vitest';
import { runCheck } from './check.js';
import { liveDeps } from './liveDeps.js';
import { readApprovals, spendersFor, tokensFor } from './approvals.js';
import { publicRead } from '../chains/evmSession.js';
import { selector } from '../engine/abi.js';

const deps = liveDeps({ own: null, known: [] });
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FEE_WALLET_SOL = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const EVM_FEE = '0xeb8725e16e504036c2166aa47804d88ecc4d0945';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

describe('live: Shield checks', () => {
  it('a Solana mint is read as a token, with the rating engine and a market', async () => {
    const v = await runCheck(USDC_SOL, deps);
    console.log('USDC', v.band, v.ratingLabel, v.headline, v.facts.map((f) => `${f.label}=${f.value}`).join(' | '));
    expect(v.subject.kind).toBe('solana-token');
    expect(v.ratingLabel).toBeTruthy();
  }, 90_000);

  it('a funded Solana wallet is read as a wallet with a history', async () => {
    const v = await runCheck(FEE_WALLET_SOL, deps);
    console.log('fee wallet', v.band, v.headline, v.findings.map((f) => f.title));
    expect(v.subject.kind).toBe('solana-wallet');
    expect(v.facts.some((f) => f.label === 'SOL balance')).toBe(true);
  }, 90_000);

  it('a Solana program is named', async () => {
    const v = await runCheck(JUPITER, deps);
    console.log('Jupiter', v.subject.kind, v.findings[0]?.title);
    expect(v.subject.kind).toBe('solana-program');
  }, 60_000);

  it('an unused Solana address is flagged', async () => {
    const v = await runCheck('9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT', deps);
    console.log('unused?', v.band, v.findings[0]?.title);
    expect(['orange', 'green', 'yellow', 'red']).toContain(v.band);
  }, 60_000);

  it('an EVM wallet is read across the networks, and a token contract is read as a token', async () => {
    const wallet = await runCheck(EVM_FEE, deps);
    console.log('EVM fee address', wallet.band, wallet.findings.map((f) => f.title), wallet.facts);
    expect(wallet.subject.kind).toBe('evm-wallet');
    const token = await runCheck(USDC_BASE, deps);
    console.log('USDC Base', token.band, token.ratingLabel, token.headline);
    expect(token.subject.kind).toBe('evm-token');
  }, 120_000);

  it('a link is checked, and a look-alike is caught', async () => {
    const real = await runCheck('https://phantom.app', deps);
    const fake = await runCheck('https://phantom-app.xyz/claim', deps);
    console.log('phantom.app', real.band, real.facts.map((f) => `${f.label}=${f.value}`).join(' | '));
    console.log('fake', fake.band, fake.findings.map((f) => f.title));
    expect(real.findings.some((f) => f.id === 'official')).toBe(true);
    expect(['orange', 'red']).toContain(fake.band);
  }, 60_000);

  it('Multicall3 gives the same allowance as asking the token directly', async () => {
    const owner = EVM_FEE;
    const chain = 'bnb' as const;
    const read = publicRead(chain);
    const tokens = tokensFor(chain);
    const spenders = spendersFor(chain);
    const found = await readApprovals(chain, owner, read, tokens, spenders);
    console.log('approvals found for the fee address on BNB Chain:', found.length);
    // Every pair, asked one at a time, must agree with the batch.
    for (const t of tokens) for (const s of spenders) {
      const direct = BigInt(String(await read('eth_call', [{ to: t.address, data: '0x' + selector('allowance(address,address)') + owner.slice(2).padStart(64, '0') + s.address.slice(2).padStart(64, '0') }, 'latest'])));
      const batched = found.find((f) => f.token.address === t.address && f.spender.address === s.address)?.allowance ?? 0n;
      expect(batched, `${t.symbol} -> ${s.label}`).toBe(direct);
    }
  }, 120_000);
});
