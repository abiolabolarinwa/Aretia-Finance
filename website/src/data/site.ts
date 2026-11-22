/**
 * Single source of truth for every factual claim the site makes. Figures
 * come from the protocol docs in this repo (TOKENOMICS.md, PROTOCOL.md,
 * MINT_V2.md, MANAGEMENT_FEE.md) and from what the Aretia
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
  slug: 'wallet' | 'pay' | 'shield';
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
  { title: 'Public APIs & SDKs', status: 'roadmap' as Status, detail: 'Developer APIs for Aretia services.' },
];

export const NETWORKS =['Solana', 'Ethereum', 'Base', 'BNB Smart Chain', 'Polygon'];

export const LINKS = {
  // The wallet extension is not yet published to the Chrome Web Store, so
  // every "launch" CTA points to a waitlist capture, not a live product.
  walletWaitlist: '/wallet/about#waitlist',
  whitepaper: '/whitepaper',
  github: 'https://github.com/abiolabolarinwa/Aretia-Finance',
  telegram: 'https://t.me/+MWgiRISNMWM2NmI0',
  discord: 'https://discord.gg/fDXvn2nHf',
  x: 'https://x.com/AretiaFinance',
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
      { label: 'Open wallet', href: '/wallet', description: 'Balances, activity and trading in your browser' },
      { label: 'Aretia Wallet', href: '/wallet/about', description: 'Multichain self-custody wallet' },
      { label: 'Features', href: '/features', description: 'Everything the wallet does today' },
      { label: 'Pay', href: '/features#pay', description: 'Send to ENS and .sol names' },
      { label: 'Shield', href: '/features#shield', description: 'Pre-send safety checks' },
    ],
  },
  {
    label: 'Company',
    items: [
      { label: 'About', href: '/about', description: 'Why Aretia exists' },
      { label: 'Blog', href: '/blog', description: 'Notes from the team' },
      { label: 'Learn', href: '/learn', description: 'Guides to checking tokens and apps' },
      { label: 'Support', href: '/support', description: 'Answers and guides' },
      { label: 'Contact', href: '/contact', description: 'Get in touch' },
    ],
  },
];
