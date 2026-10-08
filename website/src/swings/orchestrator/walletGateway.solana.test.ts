import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { solanaSignatureStatus, WalletExecutionGateway } from './walletGateway.js';
import { WalletSessionManager } from '../wallet/sessionManager.js';
import { NO_CAPABILITIES, type WalletAdapter, type WalletSession } from '../wallet/types.js';
import { buildDepositForBurn, evmAddressBytes32, SOLANA_CCTP_PROGRAMS } from '../settlement/cctpSolana.js';
import type { SettlementTransaction } from '../settlement/types.js';

const OWNER = web3.Keypair.generate().publicKey.toBase58();
const OTHER = web3.Keypair.generate().publicKey.toBase58();

class SolWallet implements WalletAdapter {
  readonly providerId = 'sol';
  readonly providerName = 'Sol';
  readonly chainType = 'solana' as const;
  sent: unknown[] = [];
  constructor(private address: string) {}
  getSession(): WalletSession {
    return { providerId: 'sol', providerName: 'Sol', chainType: 'solana', address: this.address, accounts: [this.address], chain: 'solana', networkId: null, state: 'connected', capabilities: NO_CAPABILITIES, connectedAt: 1, revision: 1 };
  }
  isConnected = () => true;
  async connect() { return this.getSession(); }
  async restore() { return this.getSession(); }
  async disconnect() {}
  async refresh() { return this.getSession(); }
  async getAddress() { return this.address; }
  async getBalance(): Promise<never> { throw new Error('unused'); }
  async signTransaction(): Promise<never> { throw new Error('unused'); }
  async signMessage(): Promise<never> { throw new Error('unused'); }
  async sendTransaction(tx: unknown) { this.sent.push(tx); return '5'.repeat(88); }
  async switchNetwork(): Promise<never> { throw new Error('unused'); }
  onChange(): () => void { return () => undefined; }
}

const burn = (owner = OWNER): SettlementTransaction => ({
  stepId: 'burn', chain: 'solana', description: 'burn',
  unsigned: { kind: 'solana', transaction: buildDepositForBurn(web3, { owner, amount: 10_000_000n, destinationDomain: 6, mintRecipient: evmAddressBytes32('0x' + 'ab'.repeat(20)), maxFee: 1000n, minFinalityThreshold: 1000, recentBlockhash: web3.Keypair.generate().publicKey.toBase58(), messageEventKey: web3.Keypair.generate() }) },
});
const setup = (account = OWNER, status?: (s: string) => Promise<'confirmed' | 'failed' | 'pending'>) => {
  const wallet = new SolWallet(account);
  const manager = new WalletSessionManager(null);
  manager.add(wallet);
  manager.setActive('sol');
  return { wallet, gateway: new WalletExecutionGateway(manager, () => async () => null, undefined, status) };
};

describe('the gateway on Solana', () => {
  it('sends a CCTP burn built for the connected account, once', async () => {
    const { wallet, gateway } = setup();
    expect(await gateway.send(burn(), { address: OWNER, allowedDestinations: SOLANA_CCTP_PROGRAMS })).toBe('5'.repeat(88));
    expect(wallet.sent).toHaveLength(1);
  });

  it('refuses a transaction paid for by another account, one for another account, and one that calls a program nobody declared', async () => {
    const { wallet, gateway } = setup();
    await expect(gateway.send(burn(OTHER), { address: OWNER, allowedDestinations: SOLANA_CCTP_PROGRAMS })).rejects.toThrow(/different account|paid for by/);
    await expect(setup(OTHER).gateway.send(burn(), { address: OWNER, allowedDestinations: SOLANA_CCTP_PROGRAMS })).rejects.toThrow(/not the account/);
    await expect(gateway.send(burn(), { address: OWNER, allowedDestinations: ['11111111111111111111111111111111'] })).rejects.toThrow(/program Aretia does not recognise/);
    await expect(gateway.send(burn(), { address: OWNER, allowedDestinations: [] })).rejects.toThrow(/declared no addresses/);
    expect(wallet.sent).toHaveLength(0);
  });

  it('reports a Solana outcome only as the cluster says it: pending until confirmed, failed on an error', async () => {
    const reply = (value: unknown) => solanaSignatureStatus((async () => ({ value: [value] })) as never);
    expect(await reply(null)('s')).toBe('pending');
    expect(await reply({ err: null, confirmationStatus: 'processed' })('s')).toBe('pending');
    expect(await reply({ err: null, confirmationStatus: 'confirmed' })('s')).toBe('confirmed');
    expect(await reply({ err: null, confirmationStatus: 'finalized' })('s')).toBe('confirmed');
    expect(await reply({ err: { InstructionError: [0, 'x'] }, confirmationStatus: 'confirmed' })('s')).toBe('failed');
  });

  it('refuses to guess a Solana confirmation when no status source was given', async () => {
    await expect(setup().gateway.confirmation('solana', 's')).rejects.toThrow(/not available here/);
    expect(await setup(OWNER, async () => 'confirmed').gateway.confirmation('solana', 's')).toBe('confirmed');
  });
});
