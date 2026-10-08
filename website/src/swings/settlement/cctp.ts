/**
 * USDC settlement through Circle's Cross-Chain Transfer Protocol V2 (CCTP): USDC is BURNED on the source chain and the
 * same amount, less any fee, is MINTED on the destination chain. No wrapped token and no pool of locked funds is
 * involved, which is why it is the first production settlement strategy.
 *
 * Nothing here assumes the five Swings chains behave alike. Support is decided per request, from three independent
 * sources, and a route is offered only if all agree and Aretia can really build it:
 *   1. Aretia's own table of CCTP domains and USDC addresses (from Circle's published list, dated below);
 *   2. Circle's live service, which rejects a pair it does not support (it rejects BNB Chain, for example);
 *   3. the chain itself: Circle's token minter must report a burn limit for USDC on the source chain.
 * And a route needs transactions Aretia can build and a way to follow them. Today that is EVM to EVM; Solana legs are
 * answered "not built yet" with that reason, never offered.
 *
 * Two providers share this code, "standard" (finality 2000, no fee, 15 to 19 minutes from Ethereum and the big L2s)
 * and "fast" (finality 1000, a small fee, seconds), so the quote engine can compare cost against time.
 *
 * Sources, 7 Oct 2026: developers.circle.com/cctp (supported chains, finality), iris-api.circle.com (fees, attestations),
 * contract addresses from Circle's EVM smart contracts page.
 */
import type * as Web3 from '@solana/web3.js';
import { CHAINS, SwingsError, type ChainId } from '../core/types.js';
import { ataAddress, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import type { SolRpc } from '../solana/raydiumCpmm.js';
import { buildDepositForBurn, buildReceiveMessage, cctpSolanaAddresses, evmAddressBytes32, hexToBytes, isSolanaAddress, readBurnLimit, readFeeRecipient, SOLANA_CCTP_PROGRAMS, SOLANA_USDC, usedNonceAddress } from './cctpSolana.js';
import type { EvmRead } from '../chains/evmSession.js';
import { decodeParams, encodeFunction } from '../engine/abiGeneric.js';
import { executionIdOf, parseExecutionId, type SettlementCost, type SettlementIntent, type SettlementProvider, type SettlementQuote, type SettlementStatus, type SettlementStep, type SettlementTransaction, type SupportAnswer } from './types.js';

/** CCTP domain ids, from Circle's list. BNB Chain is deliberately absent: Circle does not support USDC there. */
export const CCTP_DOMAIN: Readonly<Partial<Record<ChainId, number>>> = { ethereum: 0, avalanche: 1, optimism: 2, arbitrum: 3, solana: 5, base: 6, polygon: 7 };

/** Native USDC on each chain (issued by Circle, not bridged). Checked against the chain by the live tests. */
export const CCTP_USDC: Readonly<Partial<Record<ChainId, string>>> = {
  ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  avalanche: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
  optimism: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  arbitrum: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  polygon: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

/** CCTP V2 contracts. The same address on every EVM mainnet Aretia supports. */
export const CCTP_CONTRACTS = {
  tokenMessenger: '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d',
  messageTransmitter: '0x81d40f21f12a8f0e3252bccb954d722d4c464b64',
  tokenMinter: '0xfd78ee919681417d192449715b2594ab58f5d002',
} as const;

export const FINALITY_FAST = 1000;
export const FINALITY_STANDARD = 2000;

/** Chains whose published CCTP "fast transfer" works from them as a source. */
const FAST_SOURCE = new Set<ChainId>(['ethereum', 'optimism', 'arbitrum', 'base', 'solana']);

/** Average attestation times, in seconds, from Circle's published figures. */
const ATTEST_SECONDS: Readonly<Record<'fast' | 'standard', Partial<Record<ChainId, number>>>> = {
  fast: { ethereum: 20, arbitrum: 8, base: 8, optimism: 8, solana: 8 },
  standard: { ethereum: 19 * 60, arbitrum: 19 * 60, base: 19 * 60, optimism: 19 * 60, avalanche: 8, polygon: 8, solana: 25 },
};
/** Time to send the source transaction and to claim on the destination, on top of the attestation. */
const HANDLING_SECONDS = 60;

/** What the provider needs to touch Solana: a node, and the (lazily loaded) Solana library. Absent means Solana is not offered. */
export interface SolanaCctpDeps {
  rpc: SolRpc;
  web3: () => Promise<typeof Web3>;
}

export interface CctpOptions {
  mode: 'fast' | 'standard';
  read: (chain: ChainId) => EvmRead;
  solana?: SolanaCctpDeps;
  fetchImpl?: typeof fetch;
  now?: () => number;
  irisBase?: string;
  /** How long a quote stays valid. Fees can change, so it is short. */
  quoteTtlMs?: number;
}

interface IrisFee {
  finalityThreshold: number;
  minimumFee: number;
}

/** What the provider remembers about a quote, so it can build the transactions later. */
interface CctpRaw {
  mode: 'fast' | 'standard';
  srcDomain: number;
  dstDomain: number;
  usdc: string;
  amount: bigint;
  maxFee: bigint;
  minFinalityThreshold: number;
  needsApproval: boolean;
  tokenMessenger: string;
}

const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);
const isSolana = (c: ChainId): boolean => CHAINS[c].kind === 'solana';
const validAddress = (c: ChainId, a: string): boolean => (isSolana(c) ? isSolanaAddress(a) : isEvmAddress(a));
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const bytes32OfAddress = (a: string): string => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
const ZERO32 = '0x' + '0'.repeat(64);

/** Fee for `amount` at `bps` basis points (may be fractional), rounded UP so the cap is never below what is charged. */
export function feeFor(amount: bigint, bps: number): bigint {
  if (!(bps > 0)) return 0n;
  const milli = BigInt(Math.round(bps * 1000));
  const denominator = 10_000_000n;
  return (amount * milli + denominator - 1n) / denominator;
}

export class CctpSettlementProvider implements SettlementProvider {
  readonly id: string;
  readonly name: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly iris: string;

  constructor(private readonly o: CctpOptions) {
    this.id = `circle-cctp-${o.mode}`;
    this.name = `Circle CCTP (${o.mode} transfer)`;
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.now = o.now ?? Date.now;
    this.iris = o.irisBase ?? 'https://iris-api.circle.com';
  }

  // ------------------------------------------------------------------ support

  private async irisJson(path: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: unknown }> {
    const res = await this.fetchImpl(`${this.iris}${path}`, { headers: { accept: 'application/json' }, signal });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  }

  private async fees(src: number, dst: number, signal?: AbortSignal): Promise<IrisFee[] | { error: string }> {
    let r: Awaited<ReturnType<CctpSettlementProvider['irisJson']>>;
    try {
      r = await this.irisJson(`/v2/burn/USDC/fees/${src}/${dst}`, signal);
    } catch {
      return { error: 'Circle\'s service could not be reached, so this route cannot be confirmed right now.' };
    }
    if (r.status === 400 || r.status === 404) return { error: 'Circle does not support this pair of chains for USDC.' };
    if (!r.ok || !Array.isArray(r.body)) return { error: 'Circle\'s service did not give a usable answer, so this route cannot be confirmed right now.' };
    const rows = (r.body as { finalityThreshold?: unknown; minimumFee?: unknown }[]).filter((x): x is IrisFee => typeof x.finalityThreshold === 'number' && typeof x.minimumFee === 'number' && x.minimumFee >= 0);
    return rows.length > 0 ? rows : { error: 'Circle returned no fee for this route.' };
  }

  async supports(intent: SettlementIntent, signal?: AbortSignal): Promise<SupportAnswer> {
    const no = (reason: string): SupportAnswer => ({ supported: false, reason });
    const src = CCTP_DOMAIN[intent.sourceChain];
    const dst = CCTP_DOMAIN[intent.destinationChain];
    if (src === undefined) return no(intent.sourceChain === 'bnb' ? 'Circle does not offer USDC settlement on BNB Chain.' : `Circle's USDC settlement is not available on ${CHAINS[intent.sourceChain].name}.`);
    if (dst === undefined) return no(intent.destinationChain === 'bnb' ? 'Circle does not offer USDC settlement on BNB Chain.' : `Circle's USDC settlement is not available on ${CHAINS[intent.destinationChain].name}.`);
    if (intent.sourceAsset.address.toLowerCase() !== CCTP_USDC[intent.sourceChain]!.toLowerCase() || intent.destinationAsset.address.toLowerCase() !== CCTP_USDC[intent.destinationChain]!.toLowerCase()) return no('This route settles native USDC to native USDC only.');
    if ((isSolana(intent.sourceChain) || isSolana(intent.destinationChain)) && !this.o.solana) return no('The Solana side of a USDC settlement is not available in this context, so this route is not offered.');
    if (!validAddress(intent.sourceChain, intent.sender) || !validAddress(intent.destinationChain, intent.recipient)) return no('The sender and recipient must be valid addresses on their chains.');
    if (this.o.mode === 'fast' && !FAST_SOURCE.has(intent.sourceChain)) return no(`${CHAINS[intent.sourceChain].name} does not offer fast transfer as a source; the standard transfer is the option there.`);
    const fees = await this.fees(src, dst, signal);
    if ('error' in fees) return no(fees.error);
    if (!fees.some((f) => f.finalityThreshold === (this.o.mode === 'fast' ? FINALITY_FAST : FINALITY_STANDARD))) return no(`Circle does not quote ${this.o.mode} transfer for this route.`);
    // The chain itself must agree that USDC can be burned here: its token minter reports a per-message limit.
    const limit = await this.burnLimit(intent.sourceChain);
    if (limit === null || limit === 0n) return no(`USDC cannot be burned on ${CHAINS[intent.sourceChain].name} right now (no burn limit is set).`);
    return { supported: true, reason: null };
  }

  private async solanaAccount(address: string): Promise<Uint8Array | null> {
    const r = await this.o.solana!.rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
    return r.value ? Uint8Array.from(atob(r.value.data[0]), (c) => c.charCodeAt(0)) : null;
  }

  private async burnLimit(chain: ChainId): Promise<bigint | null> {
    try {
      if (isSolana(chain)) {
        // On Solana the limit is stored in the USDC "local token" account of the Token Messenger Minter program.
        const web3 = await this.o.solana!.web3();
        const data = await this.solanaAccount(cctpSolanaAddresses(web3).localToken);
        return data ? readBurnLimit(data) : null;
      }
      const out = await this.o.read(chain)('eth_call', [{ to: CCTP_CONTRACTS.tokenMinter, data: encodeFunction('burnLimitsPerMessage(address)', [CCTP_USDC[chain]!]) }, 'latest']);
      const [v] = decodeParams(['uint256'], String(out)) as [bigint];
      return v;
    } catch {
      return null;
    }
  }

  private async allowance(chain: ChainId, owner: string): Promise<bigint> {
    const out = await this.o.read(chain)('eth_call', [{ to: CCTP_USDC[chain], data: encodeFunction('allowance(address,address)', [owner, CCTP_CONTRACTS.tokenMessenger]) }, 'latest']);
    const [v] = decodeParams(['uint256'], String(out)) as [bigint];
    return v;
  }

  // ------------------------------------------------------------------ quote

  async getQuote(intent: SettlementIntent, signal?: AbortSignal): Promise<SettlementQuote> {
    const support = await this.supports(intent, signal);
    if (!support.supported) throw new SwingsError('no-route', support.reason ?? 'Not supported.');
    const src = CCTP_DOMAIN[intent.sourceChain]!;
    const dst = CCTP_DOMAIN[intent.destinationChain]!;
    const fees = (await this.fees(src, dst, signal)) as IrisFee[];
    const finality = this.o.mode === 'fast' ? FINALITY_FAST : FINALITY_STANDARD;
    const bps = fees.find((f) => f.finalityThreshold === finality)!.minimumFee;
    const amount = intent.sourceAmount;
    const maxFee = feeFor(amount, bps);
    const limit = (await this.burnLimit(intent.sourceChain))!;
    if (amount > limit) throw new SwingsError('invalid', 'That amount is above the largest single USDC transfer this route allows.');
    if (amount <= maxFee) throw new SwingsError('invalid', 'That amount is too small to cover the settlement fee.');
    if (this.o.mode === 'fast') {
      // Fast transfer is limited by an allowance Circle publishes; a larger transfer would not be fast.
      const a = await this.fastAllowance(signal);
      if (a !== null && amount > a) throw new SwingsError('invalid', 'That amount is above the fast-transfer allowance right now. Use the standard transfer for a larger amount.');
    }
    // Solana burns are signed by the owner directly, so there is no separate approval there.
    const needsApproval = isSolana(intent.sourceChain) ? false : (await this.allowance(intent.sourceChain, intent.sender)) < amount;
    const attest = ATTEST_SECONDS[this.o.mode][intent.sourceChain];
    if (attest === undefined) throw new SwingsError('no-route', 'No timing is published for this route.');
    const srcName = CHAINS[intent.sourceChain].name;
    const dstName = CHAINS[intent.destinationChain].name;
    const steps: SettlementStep[] = [
      ...(needsApproval ? [{ id: 'approve', kind: 'approve' as const, chain: intent.sourceChain, description: `Approve exactly ${amount} (raw) USDC on ${srcName} for Circle's token messenger`, requiresSignature: true, estimatedSeconds: 15 }] : []),
      { id: 'burn', kind: 'send', chain: intent.sourceChain, description: `Burn the USDC on ${srcName} (Circle mints it on ${dstName})`, requiresSignature: true, estimatedSeconds: 15 },
      { id: 'attest', kind: 'wait', chain: intent.sourceChain, description: `Wait for Circle's attestation (${this.o.mode === 'fast' ? 'fast' : 'standard'} transfer)`, requiresSignature: false, estimatedSeconds: attest },
      { id: 'mint', kind: 'receive', chain: intent.destinationChain, description: `Claim the USDC on ${dstName} (needs a little ${CHAINS[intent.destinationChain].nativeSymbol} for the network fee)`, requiresSignature: true, estimatedSeconds: 30 },
    ];
    const usdcAsset = intent.sourceAsset;
    const settlementFee: SettlementCost = { chain: intent.sourceChain, asset: usdcAsset, amount: maxFee, description: this.o.mode === 'fast' ? `Circle's fast-transfer fee (${bps} bps), taken from the amount` : 'Circle charges nothing for a standard transfer' };
    const raw: CctpRaw = { mode: this.o.mode, srcDomain: src, dstDomain: dst, usdc: CCTP_USDC[intent.sourceChain]!, amount, maxFee, minFinalityThreshold: finality, needsApproval, tokenMessenger: CCTP_CONTRACTS.tokenMessenger };
    const t = this.now();
    return {
      id: `${this.id}:${t}:${intent.sourceChain}:${intent.destinationChain}`,
      providerId: this.id,
      intent,
      route: { providerId: this.id, mechanism: `Circle CCTP, ${this.o.mode} transfer (native USDC burn and mint)`, kind: 'transfer', steps },
      sourceAmount: amount,
      destinationAmount: amount - maxFee,
      settlementFee,
      networkFees: null,
      estimatedSeconds: attest + HANDLING_SECONDS,
      limits: { min: maxFee + 1n, max: limit },
      expiresAt: t + (this.o.quoteTtlMs ?? 120_000),
      risk: {
        level: 'low',
        trust: 'Circle, the issuer of USDC, signs the attestation that lets the USDC be minted on the destination chain. No third-party bridge holds your funds.',
        factors: [
          'Circle can blacklist USDC addresses and can pause its contracts.',
          ...(this.o.mode === 'fast' ? ['Fast transfer depends on Circle\'s fast-transfer allowance, which can run out; the amount is capped by it.'] : ['Standard transfer waits for the source chain to finalise, which can take a long time on some chains.']),
          'The USDC arrives only after you claim it on the destination chain; until then it is neither on the source nor the destination.',
        ],
      },
      requirements: [
        ...(needsApproval ? ['One approval for exactly this amount on the source chain.'] : []),
        `A little ${CHAINS[intent.destinationChain].nativeSymbol} on ${dstName} to pay the network fee when you claim.`,
        ...(isSolana(intent.destinationChain) ? ['If you have never held USDC on Solana with this wallet, the claim also pays a small one-time rent (about 0.002 SOL) to open your USDC account.'] : []),
        'Keep this page or your activity record: the claim step needs the burn transaction.',
      ],
      raw,
    };
  }

  private async fastAllowance(signal?: AbortSignal): Promise<bigint | null> {
    try {
      const r = await this.irisJson('/v2/fastBurn/USDC/allowance', signal);
      const a = (r.body as { allowance?: unknown } | null)?.allowance;
      return r.ok && typeof a === 'number' && Number.isFinite(a) ? BigInt(Math.floor(a * 1_000_000)) : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ transactions

  async buildSettlement(quote: SettlementQuote): Promise<SettlementTransaction[]> {
    if (quote.providerId !== this.id) throw new SwingsError('invalid', 'This quote was not made by this provider.');
    if (this.now() >= quote.expiresAt) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    const raw = quote.raw as CctpRaw;
    const { intent } = quote;
    if (!validAddress(intent.sourceChain, intent.sender) || !validAddress(intent.destinationChain, intent.recipient)) throw new SwingsError('invalid', 'This settlement cannot be built for these addresses.');

    if (isSolana(intent.sourceChain)) {
      const solana = this.o.solana;
      if (!solana) throw new SwingsError('invalid', 'The Solana side is not available here.');
      if (isSolana(intent.destinationChain)) throw new SwingsError('invalid', 'Both sides are Solana.');
      const web3 = await solana.web3();
      const { value } = await solana.rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const transaction = buildDepositForBurn(web3, { owner: intent.sender, amount: raw.amount, destinationDomain: raw.dstDomain, mintRecipient: evmAddressBytes32(intent.recipient), maxFee: raw.maxFee, minFinalityThreshold: raw.minFinalityThreshold, recentBlockhash: value.blockhash, messageEventKey: web3.Keypair.generate() });
      return [{ stepId: 'burn', chain: 'solana', description: `Burn ${raw.amount} (raw) USDC on Solana so it can be minted to ${intent.recipient} on ${CHAINS[intent.destinationChain].name}`, unsigned: { kind: 'solana', transaction } }];
    }

    const chainId = CHAINS[intent.sourceChain].evmChainId;
    if (chainId === null) throw new SwingsError('invalid', 'This settlement cannot be built for these addresses.');
    // To a Solana recipient the burn names the recipient's USDC token account (derived here), not their wallet.
    let mintRecipient = bytes32OfAddress(intent.recipient);
    if (isSolana(intent.destinationChain)) {
      const solana = this.o.solana;
      if (!solana) throw new SwingsError('invalid', 'The Solana side is not available here.');
      const web3 = await solana.web3();
      mintRecipient = '0x' + [...new web3.PublicKey(ataAddress(web3, intent.recipient, SOLANA_USDC, TOKEN_PROGRAM_ID)).toBytes()].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    const out: SettlementTransaction[] = [];
    if (raw.needsApproval) {
      out.push({ stepId: 'approve', chain: intent.sourceChain, description: `Approve exactly ${raw.amount} (raw) USDC for Circle's token messenger`, unsigned: { kind: 'evm', chainId, tx: { from: intent.sender, to: raw.usdc, data: encodeFunction('approve(address,uint256)', [raw.tokenMessenger, raw.amount]), value: '0x0' } } });
    }
    out.push({
      stepId: 'burn',
      chain: intent.sourceChain,
      description: `Burn ${raw.amount} (raw) USDC on ${CHAINS[intent.sourceChain].name} so it can be minted to ${intent.recipient} on ${CHAINS[intent.destinationChain].name}`,
      unsigned: {
        kind: 'evm',
        chainId,
        tx: {
          from: intent.sender,
          to: raw.tokenMessenger,
          data: encodeFunction('depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)', [raw.amount, raw.dstDomain, mintRecipient, raw.usdc, ZERO32, raw.maxFee, raw.minFinalityThreshold]),
          value: '0x0',
        },
      },
    });
    return out;
  }

  /** Circle's attested message for a burn, or null if it is not available (yet). */
  private async message(srcDomain: number, txHash: string, signal?: AbortSignal): Promise<{ status: string; message: string | null; attestation: string | null; nonce: string | null } | null> {
    const r = await this.irisJson(`/v2/messages/${srcDomain}?transactionHash=${encodeURIComponent(txHash)}`, signal);
    if (r.status === 404) return null;
    const list = (r.body as { messages?: { status?: string; message?: string; attestation?: string; eventNonce?: string }[] } | null)?.messages;
    if (!r.ok || !Array.isArray(list) || list.length === 0) return null;
    const m = list[0]!;
    return { status: String(m.status ?? ''), message: typeof m.message === 'string' && /^0x[0-9a-fA-F]+$/.test(m.message) ? m.message : null, attestation: typeof m.attestation === 'string' && /^0x[0-9a-fA-F]+$/.test(m.attestation) ? m.attestation : null, nonce: typeof m.eventNonce === 'string' && /^0x[0-9a-fA-F]{64}$/.test(m.eventNonce) ? m.eventNonce : null };
  }

  private async nonceUsed(chain: ChainId, nonce: string): Promise<boolean> {
    if (isSolana(chain)) {
      // On Solana a used message leaves an account named after its nonce.
      const web3 = await this.o.solana!.web3();
      return (await this.solanaAccount(usedNonceAddress(web3, hexToBytes(nonce)))) !== null;
    }
    const out = await this.o.read(chain)('eth_call', [{ to: CCTP_CONTRACTS.messageTransmitter, data: encodeFunction('usedNonces(bytes32)', [nonce]) }, 'latest']);
    const [v] = decodeParams(['uint256'], String(out)) as [bigint];
    return v !== 0n;
  }

  async trackSettlement(executionId: string, quote?: SettlementQuote): Promise<SettlementStatus> {
    const at = this.now();
    const parsed = parseExecutionId(executionId);
    const status = (code: SettlementStatus['code'], message: string): SettlementStatus => ({ executionId, code, destinationTxHash: null, message, updatedAt: at });
    const srcChain = parsed?.sourceChain as ChainId;
    const validTx = !!parsed && (CHAINS[srcChain]?.kind === 'solana' ? SOLANA_SIGNATURE.test(parsed.sourceTx) : /^0x[0-9a-fA-F]{64}$/.test(parsed.sourceTx));
    if (!parsed || parsed.providerId !== this.id || !validTx) return status('unknown', 'This is not a settlement this provider can follow.');
    const src = CCTP_DOMAIN[srcChain];
    const dstChain = quote?.intent.destinationChain;
    if (src === undefined) return status('unknown', 'The source chain is not one this provider settles from.');
    try {
      const m = await this.message(src, parsed.sourceTx);
      if (!m) return status('awaiting-source', 'Circle has not seen the burn yet.');
      if (m.status !== 'complete' || !m.attestation || !m.message) return status('source-confirmed', 'The burn is confirmed. Waiting for Circle\'s attestation.');
      if (dstChain && m.nonce && (await this.nonceUsed(dstChain, m.nonce))) return status('completed', 'The USDC has been minted on the destination chain.');
      return status('ready-to-complete', 'Circle has attested the burn. The USDC can be claimed on the destination chain.');
    } catch {
      return status('unknown', 'Circle\'s service could not be asked. Nothing is assumed: check again shortly.');
    }
  }

  async buildDestination(quote: SettlementQuote, executionId: string): Promise<SettlementTransaction | null> {
    if (quote.providerId !== this.id) throw new SwingsError('invalid', 'This quote was not made by this provider.');
    const parsed = parseExecutionId(executionId);
    if (!parsed || parsed.providerId !== this.id) throw new SwingsError('invalid', 'This is not a settlement this provider can follow.');
    const raw = quote.raw as CctpRaw;
    const m = await this.message(raw.srcDomain, parsed.sourceTx);
    if (!m || m.status !== 'complete' || !m.attestation || !m.message) return null;
    // Never mint twice: if the message was already used on the destination, there is nothing to send.
    if (m.nonce && (await this.nonceUsed(quote.intent.destinationChain, m.nonce))) return null;
    const dst = quote.intent.destinationChain;

    if (isSolana(dst)) {
      const solana = this.o.solana;
      if (!solana) throw new SwingsError('invalid', 'The Solana side is not available here.');
      const web3 = await solana.web3();
      const addr = cctpSolanaAddresses(web3);
      const messenger = await this.solanaAccount(addr.tokenMessenger);
      if (!messenger) throw new SwingsError('provider-failed', 'The USDC program\'s settings could not be read, so the claim was not built.');
      const { value } = await solana.rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      // The claim is built from Circle's attested message and refuses any message that does not pay this recipient's own USDC account.
      const built = buildReceiveMessage(web3, { payer: quote.intent.recipient, recipientOwner: quote.intent.recipient, message: m.message, attestation: m.attestation, localDomain: CCTP_DOMAIN.solana!, feeRecipient: readFeeRecipient(web3, messenger), recentBlockhash: value.blockhash });
      if (built.amount !== raw.amount) throw new SwingsError('invalid', 'The attested message is for a different amount than this move, so it was not claimed.');
      return { stepId: 'mint', chain: dst, description: `Claim the USDC on Solana using Circle's attestation`, unsigned: { kind: 'solana', transaction: built.transaction } };
    }

    const chainId = CHAINS[dst].evmChainId;
    if (chainId === null) throw new SwingsError('invalid', 'The destination is not an EVM chain.');
    return {
      stepId: 'mint',
      chain: dst,
      description: `Claim the USDC on ${CHAINS[dst].name} using Circle's attestation`,
      unsigned: { kind: 'evm', chainId, tx: { from: quote.intent.recipient, to: CCTP_CONTRACTS.messageTransmitter, data: encodeFunction('receiveMessage(bytes,bytes)', [m.message, m.attestation]), value: '0x0' } },
    };
  }

  allowedDestinations(chain: ChainId): readonly string[] {
    if (isSolana(chain)) return this.o.solana ? SOLANA_CCTP_PROGRAMS : [];
    const usdc = CCTP_USDC[chain];
    return usdc ? [usdc, CCTP_CONTRACTS.tokenMessenger, CCTP_CONTRACTS.messageTransmitter] : [];
  }

  executionIdFor(sourceChain: ChainId, sourceTx: string): string {
    return executionIdOf(this.id, sourceChain, sourceTx);
  }
}

/** Both CCTP modes, ready to hand to the quote engine. */
export function cctpProviders(o: Omit<CctpOptions, 'mode'>): CctpSettlementProvider[] {
  return [new CctpSettlementProvider({ ...o, mode: 'fast' }), new CctpSettlementProvider({ ...o, mode: 'standard' })];
}
