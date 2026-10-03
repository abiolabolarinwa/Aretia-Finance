/**
 * Single source of truth for every factual claim the site makes. Figures
 * come from the protocol docs in this repo (TOKENOMICS.md, PROTOCOL.md,
 * PRESALE_DESIGN.md, MINT_V2.md, MANAGEMENT_FEE.md) and from what the Aretia
 * Wallet codebase actually implements. Change a fact here, not in a page.
 * Anything not yet built is marked 'roadmap' and must render with that label.
 */

export type Status = 'live' | 'built' | 'testnet' | 'in-development' | 'roadmap';

export const STATUS_LABEL: Record<Status, string> = {
  live: 'Live',
  built: 'Built',
  testnet: 'Testnet',
  'in-development': 'In development',
  roadmap: 'Roadmap',
};

export interface Product {
  slug: 'wallet' | 'universal' | 'pay' | 'shield' | 'intent' | 'safesend';
  name: string;
  role: string;
  status: Status;
  statusNote: string;
  summary: string;
  today: string[];
  roadmap: string[];
}

export const PRODUCTS: Product[] = [
  {
    slug: 'wallet',
    name: 'Aretia Wallet',
    role: 'Multichain wallet',
    status: 'in-development',
    statusNote: 'Browser extension. Not yet published to the Chrome Web Store.',
    summary: 'One self-custody wallet for Solana and EVM networks, with the rest of Aretia built in.',
    today: [
      'Solana, Ethereum, Base, BNB Smart Chain and Polygon from one recovery phrase',
      'Send, receive, swap (via Jupiter) and activity history',
      'Custom token import and per-asset visibility',
      'Connects to dApps through EIP-1193 / EIP-6963 and the Solana Wallet Standard',
      'Keys encrypted on-device; nothing leaves the browser',
    ],
    roadmap: ['Chrome Web Store release', 'Mobile'],
  },
  {
    slug: 'universal',
    name: 'Aretia Universal',
    role: 'Interoperability',
    status: 'testnet',
    statusNote: 'ACT bridging runs on Solana devnet ↔ Sepolia today. ACT’s contracts are deployed on BNB Chain and Polygon mainnet; bridging to them is not live yet.',
    summary: 'Move ACT between chains and pay in whatever token you hold, without managing the route yourself.',
    today: [
      'ACT bridging between Solana and Ethereum over Wormhole Native Token Transfers (testnet)',
      'Automatic destination delivery through Wormhole’s Executor relay: no manual redeem step',
      'Pay-with-any-token quotes on Solana: see exactly what an exact-output payment costs in another token',
    ],
    roadmap: ['Mainnet bridging', 'More networks', 'Executing pay-with-any-token payments end to end'],
  },
  {
    slug: 'pay',
    name: 'Aretia Pay',
    role: 'Human-readable payments',
    status: 'built',
    statusNote: 'In the wallet build.',
    summary: 'Send to a name instead of a 44-character address.',
    today: [
      'Send to ENS names (vitalik.eth) and Solana Name Service names (name.sol)',
      'Names are resolved to an address and shown to you before anything is signed',
    ],
    roadmap: ['Merchant payment flows'],
  },
  {
    slug: 'safesend',
    name: 'Aretia SafeSend',
    role: 'Protected transfers',
    status: 'testnet',
    statusNote: 'Live on testnet: Ethereum Sepolia and Solana devnet. Contracts deployed on BNB Chain and Polygon mainnet, owned by a 2-of-3 Safe; not yet in the wallet, and not yet audited.',
    summary: 'Lock a transfer on-chain for a short protection period, and cancel it if something looks wrong before it reaches the recipient.',
    today: [
      'Funds wait in an on-chain vault for the protection period; only you can cancel before it ends',
      'The blockchain enforces the delay: nobody else, Aretia included, can move, redirect or hold the funds',
      'New recipients and high-value transfers get longer protection, and the wallet says why',
    ],
    roadmap: ['Security audit', 'Mainnet in the wallet', 'Base'],
  },
  {
    slug: 'shield',
    name: 'Aretia Shield',
    role: 'Transaction safety',
    status: 'built',
    statusNote: 'Pre-send checks in the wallet build. Privacy features are on the roadmap, not built.',
    summary: 'Checks every recipient and approval before you sign, and says plainly when something looks wrong.',
    today: [
      'Recipient checks before sending: whether it is a contract or a wallet, and whether the address has any on-chain activity at all',
      'Warnings on unlimited token approvals and on transactions it cannot decode',
      'Chain-mismatch warnings when a dApp asks for a transaction on the wrong network',
    ],
    roadmap: ['Privacy-preserving transaction options'],
  },
  {
    slug: 'intent',
    name: 'Aretia Intent',
    role: 'Plain-language transactions',
    status: 'built',
    statusNote: 'Version 1: a deterministic phrase parser, not an AI model.',
    summary: 'Type what you want to do; Aretia turns it into a transaction you review before signing.',
    today: [
      'Understands phrases like “send 5 ACT to alex.sol”',
      'Always produces a normal review screen: nothing is sent from the phrase alone',
    ],
    roadmap: ['Route discovery across chains and liquidity sources'],
  },
];

export const ACT = {
  ticker: 'ACT',
  network: 'Solana',
  standard: 'SPL Token-2022',
  mint: '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG',
  totalSupply: 1_000_000_000,
  mintAuthority: 'Revoked: supply can never increase',
  freezeAuthority: 'Revoked: no wallet can be frozen',
  projectRegistrationFee: 5_000,
  treasuryMultisig: 'GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA',
  /** Token-2022 transfer fee, withheld by the token program on every transfer. */
  transferFee: {
    totalPercent: 1.5,
    /**
     * Set only while a fee change is scheduled on-chain but not yet in effect
     * (Token-2022 applies a fee change two epochs after approval). While set,
     * the nav shows a notice and fee figures say when the new rate starts.
     * The 1.5% rate took effect at Solana epoch 1048 (2 Oct 2026), so it is unset.
     */
    scheduled: undefined as { fromEpoch: number; previousPercent: number } | undefined,
    note: 'Withheld on-chain by the Token-2022 program on every transfer (150 basis points). The treasury multisig collects the withheld fees and splits them as below.',
    split: [
      { label: 'Climate Treasury', percent: 1, detail: 'Catalyst fund for climate projects, held in a 2-of-3 multisig' },
      { label: 'Management fee', percent: 0.5, detail: 'Treasury operations: verification, reporting, monitoring' },
    ],
  },
  utilities: [
    { name: 'Transfer fee', status: 'live' as Status, detail: 'Every ACT transfer funds the Climate Treasury and treasury operations.' },
    { name: 'Staking', status: 'in-development' as Status, detail: 'Lock ACT to build a Capital Access Score.' },
    { name: 'Project registration', status: 'live' as Status, detail: `Project developers pay a ${(5000).toLocaleString('en-US')} ACT fee to apply for catalyst funding.` },
    { name: 'Aretia service fees', status: 'roadmap' as Status, detail: 'ACT as the fee layer across Wallet, Universal, Pay, Shield and Intent.' },
  ],
};

/**
 * ACT's launch pools (Meteora DAMM v2), created by the treasury multisig on
 * 2 Oct 2026. Single-sided: each opened with only ACT, at the floor price, so
 * nothing can trade below it. Liquidity is permanently locked (verified
 * on-chain: unlocked liquidity 0 in both positions).
 */
export const POOLS: { pair: string; address: string; floor: string; explorer: string; chart?: string }[] = [
  {
    pair: 'ACT/USDC',
    address: '6n8Mvd7xmZs66E5VLGQGvtE31gbKMcTL4S97W4oV6ivX',
    floor: '0.005 USDC per ACT',
    explorer: 'https://solscan.io/account/6n8Mvd7xmZs66E5VLGQGvtE31gbKMcTL4S97W4oV6ivX',
    // DexScreener lists a pool once it has traded; ACT/SOL has not yet, so it has no chart link.
    chart: 'https://dexscreener.com/solana/6n8mvd7xmzs66e5vlgqgvte31gbkmctl4s97w4ov6ivx',
  },
  {
    pair: 'ACT/SOL',
    address: 'ECJYQzo2YfWTChEnNsaThC5Aeng1hxfbfNG8DQVgkSkb',
    floor: 'about $0.005 per ACT in SOL, fixed in SOL at creation',
    explorer: 'https://solscan.io/account/ECJYQzo2YfWTChEnNsaThC5Aeng1hxfbfNG8DQVgkSkb',
  },
];

export const CLIMATE = {
  functionalAllocation: [
    { label: 'Climate mitigation', percent: 60 },
    { label: 'Climate adaptation', percent: 20 },
    { label: 'Ecosystem development', percent: 10 },
    { label: 'MRV / verification', percent: 5 },
    { label: 'Emergency reserve', percent: 5 },
  ],
  allocationNote: 'Illustrative starting weights; governance can revise them.',
};

export const SECURITY = [
  { title: 'Encrypted on your device', detail: 'Your recovery phrase is encrypted with AES-256-GCM using a key derived from your password (PBKDF2-HMAC-SHA256). It never leaves the browser.' },
  { title: 'Every request needs you', detail: 'Connections, signatures and transactions from websites wait in an approval queue until you accept or reject them.' },
  { title: 'Per-site permissions', detail: 'Each website sees only the accounts you connected it to, and you can revoke a site at any time.' },
  { title: 'Auto-lock', detail: 'The wallet locks itself after a period of inactivity.' },
  { title: 'Readable review screens', detail: 'Transactions are decoded before you sign; anything the wallet cannot decode is labelled as such, never guessed.' },
  { title: 'Aretia Shield', detail: 'Recipient checks and approval warnings before you send.' },
];

export const DEVELOPERS = [
  { title: 'EVM provider', status: 'built' as Status, detail: 'EIP-1193 provider, discoverable through EIP-6963 alongside other installed wallets.' },
  { title: 'Solana Wallet Standard', status: 'built' as Status, detail: 'Connect, sign transactions, sign-and-send and sign messages through the standard Solana wallet interface.' },
  { title: 'Pluggable bridge providers', status: 'built' as Status, detail: 'A provider-agnostic bridge interface: integrations hand back unsigned transactions; they never hold keys.' },
  { title: 'Verifiable token', status: 'live' as Status, detail: 'ACT is a standard SPL Token-2022 mint: supply, authorities and fee configuration are readable on-chain.' },
  { title: 'Public APIs & SDKs', status: 'roadmap' as Status, detail: 'Developer APIs for Aretia services.' },
];

export const NETWORKS =['Solana', 'Ethereum', 'Base', 'BNB Smart Chain', 'Polygon'];

export const LINKS = {
  // The wallet extension is not yet published to the Chrome Web Store, so
  // every "launch" CTA points to a waitlist capture, not a live product.
  walletWaitlist: '/wallet#waitlist',
  buyAct: '/buy',
  whitepaper: '/whitepaper',
  github: 'https://github.com/abiolabolarinwa/Aretia-Finance',
  telegram: 'https://t.me/+MWgiRISNMWM2NmI0',
  discord: 'https://discord.gg/fDXvn2nHf',
  x: 'https://x.com/AretiaFinance',
  explorerMint: `https://solscan.io/token/7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG`,
  // Shares the project-application Formspree form for now (messages are
  // tagged "Website contact" in the subject). Swap for a dedicated form ID.
  contactForm: 'https://formspree.io/f/xaeypjob',
};

export interface NavGroup {
  label: string;
  items: { label: string; href: string; description: string }[];
}

export const NAV: NavGroup[] = [
  {
    label: 'Products',
    items: [
      { label: 'Aretia Wallet', href: '/wallet', description: 'Multichain self-custody wallet' },
      { label: 'Features', href: '/features', description: 'Everything the wallet does today' },
      { label: 'Universal', href: '/features#universal', description: 'Cross-chain ACT and any-token pay' },
      { label: 'Pay', href: '/features#pay', description: 'Send to ENS and .sol names' },
      { label: 'Shield', href: '/features#shield', description: 'Pre-send safety checks' },
      { label: 'Intent', href: '/features#intent', description: 'Plain-language transactions' },
    ],
  },
  {
    label: 'Ecosystem',
    items: [
      { label: 'Ecosystem map', href: '/ecosystem', description: 'How every part connects' },
      { label: 'Climate Treasury', href: '/details', description: 'Where the 2% goes' },
      { label: 'Capital Marketplace', href: '/marketplace', description: 'Climate projects seeking capital' },
      { label: 'Submit a project', href: '/apply', description: 'Apply for catalyst funding' },
    ],
  },
  {
    label: 'ACT',
    items: [
      { label: 'Token', href: '/token', description: 'Supply, fees and utility' },
      { label: 'Buy ACT', href: '/buy', description: 'Swap into ACT via Jupiter' },
      { label: 'Staking', href: '/stake', description: 'Capital Access Score' },
      { label: 'Verify', href: '/verify', description: 'Check the mint on-chain' },
    ],
  },
  {
    label: 'Developers',
    items: [
      { label: 'Docs', href: '/docs', description: 'Build with Aretia' },
      { label: 'Whitepaper', href: '/whitepaper', description: 'Protocol design' },
      { label: 'Roadmap', href: '/roadmap', description: 'What ships next' },
    ],
  },
  {
    label: 'Company',
    items: [
      { label: 'About', href: '/about', description: 'Why Aretia exists' },
      { label: 'Blog', href: '/blog', description: 'Notes from the team' },
      { label: 'Support', href: '/support', description: 'Answers and guides' },
      { label: 'Contact', href: '/contact', description: 'Get in touch' },
    ],
  },
];
