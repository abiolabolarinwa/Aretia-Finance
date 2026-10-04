/** FAQs and docs sections. Same accuracy rule as site.ts: describe what is built, label the rest. */

export const SUPPORT_CATEGORIES = ['Wallet', 'Transactions', 'ACT', 'Bridging', 'Shield', 'Pay', 'Intent', 'Security'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export interface Faq {
  id: string;
  category: SupportCategory;
  q: string;
  a: string;
}

export const FAQS: Faq[] = [
  { id: 'install', category: 'Wallet', q: 'How do I install Aretia Wallet?', a: 'Aretia Wallet is a browser extension that is still in development and not yet published to the Chrome Web Store. Once it is, you will install it from the store listing linked on the wallet page.' },
  { id: 'networks', category: 'Wallet', q: 'Which networks does Aretia Wallet support?', a: 'Solana, Ethereum, Base, BNB Smart Chain and Polygon, all from one recovery phrase. Solana devnet and Ethereum Sepolia are available for testing.' },
  { id: 'recovery', category: 'Wallet', q: 'What happens if I lose my recovery phrase?', a: 'Aretia is self-custody: nobody, including Aretia Finance, can recover your wallet for you. Write the phrase down offline and store it somewhere safe.' },
  { id: 'web-dashboard', category: 'Wallet', q: 'What is the web wallet at aretiafinance.org/wallet?', a: 'A page where you connect a Solana wallet you already use (Phantom, Solflare, Backpack, the Aretia extension and others) to see your balances and activity, send SOL or tokens (to an address or a .sns name), and trade ACT through Jupiter. It never asks for your recovery phrase and never holds keys: your own wallet signs everything. To show your holdings it sends your public address to Jupiter, DexScreener and a Solana RPC. It also has Shield, which checks an address you paste (sent to the same RPC), and Intent, which turns a phrase like "swap 0.1 SOL for ACT" or "send 5 USDC to bob.sns" into a pre-filled swap or send. Before a send, the page simulates it and shows you the full recipient address; your own wallet signs it, and you can decline.' },
  { id: 'review', category: 'Transactions', q: 'What will I see before I sign a transaction?', a: 'A review screen with the decoded transaction: recipient, amount and an estimated network fee. If the wallet cannot decode something, it says so rather than guessing.' },
  { id: 'fees', category: 'Transactions', q: 'Does Aretia charge a fee on my transactions?', a: 'No. You pay the normal network fee. ACT transfers additionally carry ACT’s own 1.5% on-chain transfer fee, which is part of the token, not an Aretia Wallet charge. ACT-denominated service fees for Aretia products are on the roadmap.' },
  { id: 'swap', category: 'Transactions', q: 'How do swaps work?', a: 'Swaps on Solana are routed through Jupiter. You see the quote first and confirm it in the wallet.' },
  { id: 'act-what', category: 'ACT', q: 'What is ACT?', a: 'Aretia’s ecosystem token: an SPL Token-2022 mint on Solana mainnet with a fixed supply of 1,000,000,000. Its mint and freeze authorities are revoked.' },
  { id: 'act-fee', category: 'ACT', q: 'Why do ACT transfers arrive slightly smaller?', a: 'Every ACT transfer has a 1.5% fee withheld by the Token-2022 program itself. The treasury collects it and splits it: 1% to the Climate Treasury and 0.5% to treasury operations.' },
  { id: 'act-mint', category: 'ACT', q: 'How do I verify the real ACT mint?', a: 'The mint address is 7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG. Check it on the Verify page or any Solana explorer, and never trust a token by name alone.' },
  { id: 'act-presale', category: 'ACT', q: 'Is there an ACT presale?', a: 'No. The planned presale has been cancelled, and no presale will take place. ACT is acquired by trading in its liquidity pools, which opened on 2 October 2026; see the Buy page.' },
  { id: 'act-liquidity', category: 'ACT', q: 'Is ACT’s liquidity locked?', a: 'Yes. ACT trades in two Meteora pools (ACT/USDC and ACT/SOL), each seeded by the treasury with about 4.9 million ACT at a floor of $0.005. The liquidity is permanently locked, so no one, the treasury included, can withdraw it. The pool addresses are on the Buy page. Pool trading adds a 0.25% pool fee on top of ACT’s 1.5% transfer fee, and nothing here is investment advice.' },
  { id: 'bridge-what', category: 'Bridging', q: 'Can I move ACT to Ethereum?', a: 'Aretia Universal bridges ACT between Solana and Ethereum using Wormhole Native Token Transfers. It currently runs on testnet (Solana devnet ↔ Sepolia) only.' },
  { id: 'bridge-redeem', category: 'Bridging', q: 'Do I need to claim bridged ACT on the other chain?', a: 'No. Wormhole’s Executor relay delivers the transfer on the destination chain automatically once the source transaction is attested.' },
  { id: 'bridge-approve', category: 'Bridging', q: 'Why does bridging from Ethereum ask me to sign twice?', a: 'The first signature is a standard ERC-20 approval allowing the bridge contract to move exactly that amount of ACT; the second is the transfer itself. Each is shown in its own review screen.' },
  { id: 'shield-what', category: 'Shield', q: 'What does Aretia Shield check?', a: 'Before you send, Shield checks whether the recipient is a contract or a wallet and whether the address has any on-chain activity. It also warns about unlimited token approvals and transactions it cannot decode.' },
  { id: 'shield-privacy', category: 'Shield', q: 'Does Shield make my transactions private?', a: 'No. Shield is a safety check, not a privacy tool. Privacy-preserving transaction options are on the roadmap and are not built.' },
  { id: 'shield-warning', category: 'Shield', q: 'Shield warned me about a new address. What should I do?', a: 'A brand-new address with no on-chain activity is common for fresh wallets, but also for typos and scams. Confirm the address with the recipient through another channel before sending.' },
  { id: 'pay-names', category: 'Pay', q: 'Which names can I send to?', a: 'ENS names like vitalik.eth on EVM networks and Solana Name Service names ending in .sol on Solana.' },
  { id: 'pay-resolve', category: 'Pay', q: 'How do I know a name went to the right address?', a: 'The wallet resolves the name first and shows you the resulting address on the review screen before you sign.' },
  { id: 'intent-what', category: 'Intent', q: 'What can I type into Aretia Intent?', a: 'Simple phrases such as “send 5 ACT to alex.sol”. Version 1 is a deterministic parser, not an AI model: it understands a fixed set of phrasings.' },
  { id: 'intent-safety', category: 'Intent', q: 'Can Intent send funds without asking me?', a: 'No. Intent only builds a transaction; you always get the normal review screen and must sign it yourself.' },
  { id: 'sec-keys', category: 'Security', q: 'Where are my keys stored?', a: 'Encrypted on your device with AES-256-GCM, using a key derived from your password with PBKDF2-HMAC-SHA256. They never leave the browser.' },
  { id: 'sec-sites', category: 'Security', q: 'How do I disconnect a website?', a: 'Open Settings → Connected sites in the wallet and remove it. Each site only ever sees the accounts you connected it to.' },
  { id: 'sec-support', category: 'Security', q: 'Will Aretia support ever ask for my recovery phrase?', a: 'Never. Anyone asking for your recovery phrase or private key is attempting to steal your funds.' },
];

export interface DocSection {
  id: string;
  title: string;
  summary: string;
  body: string[];
  links?: { label: string; href: string }[];
}

export const DOCS: DocSection[] = [
  { id: 'getting-started', title: 'Getting started', summary: 'What Aretia is and where to begin.', body: ['Aretia is a self-custody wallet with built-in products (Universal, Pay, Shield and Intent) and ACT, a token whose transfer fee funds a Climate Treasury.', 'The wallet extension is in development. Until it is published, these docs describe the built software and label what is roadmap.'], links: [{ label: 'Features', href: '/features' }, { label: 'Ecosystem', href: '/ecosystem' }] },
  { id: 'wallet', title: 'Wallet', summary: 'Accounts, networks and signing.', body: ['One recovery phrase derives accounts for Solana and every supported EVM network. Assets, activity and custom tokens are tracked per network.', 'All signing happens inside the extension after a decoded review screen.'], links: [{ label: 'Wallet overview', href: '/wallet' }] },
  { id: 'act', title: 'ACT', summary: 'Supply, fee mechanics and verification.', body: ['ACT is an SPL Token-2022 mint (7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG) with a fixed 1,000,000,000 supply and revoked mint and freeze authorities.', 'A 350 basis-point transfer fee is withheld by the token program on every transfer; the treasury multisig holds the fee authority.'], links: [{ label: 'Token page', href: '/token' }, { label: 'Verify', href: '/verify' }] },
  { id: 'universal', title: 'Aretia Universal', summary: 'Cross-chain ACT over Wormhole NTT.', body: ['Solana runs the NTT hub in locking mode; Ethereum runs a spoke in burning mode. Wormhole’s Executor relays delivery automatically.', 'EVM-side transfers are two steps (ERC-20 approve, then transfer), each built fresh and reviewed separately. Testnet only today.'] },
  { id: 'shield', title: 'Aretia Shield', summary: 'Pre-send recipient and approval checks.', body: ['Shield reads the recipient on-chain: bytecode or program ownership decides contract vs. wallet; transaction count and balance decide whether the address has any activity.', 'Unlimited ERC-20 approvals and undecodable transactions raise explicit warnings.'] },
  { id: 'intent', title: 'Aretia Intent', summary: 'Plain-language transaction building.', body: ['Intent v1 deterministically parses a phrase into action, amount, asset and recipient, then hands a normal transaction to the review screen.', 'Relative amounts, currency conversion and multi-step routing are out of scope for v1.'] },
  { id: 'pay', title: 'Aretia Pay', summary: 'ENS and SNS name resolution.', body: ['Recipients can be ENS names (.eth) or Solana Name Service names (.sol). Names are resolved before review and the resulting address is always shown.'] },
  { id: 'developer-apis', title: 'Developer APIs', summary: 'Standard wallet interfaces, today.', body: ['Aretia exposes an EIP-1193 provider (announced via EIP-6963) and implements the Solana Wallet Standard, so existing dApp integrations work without Aretia-specific code.', 'Dedicated Aretia service APIs and SDKs are on the roadmap.'] },
  { id: 'smart-contracts', title: 'Smart contracts', summary: 'On-chain components and where they run.', body: ['ACT: SPL Token-2022 mint on Solana mainnet. Treasury: a 2-of-3 Squads multisig holding the fee authorities.', 'Bridge: Wormhole NTT manager and transceiver on Solana devnet and Sepolia (testnet), with the Sepolia token administered by a 2-of-3 Safe.'], links: [{ label: 'Protocol source on GitHub', href: 'https://github.com/abiolabolarinwa/Aretia-Finance' }] },
  { id: 'security', title: 'Security', summary: 'How keys and requests are protected.', body: ['Recovery phrases are encrypted with AES-256-GCM under a PBKDF2-HMAC-SHA256-derived key and never leave the device. The wallet auto-locks after inactivity.', 'Website requests queue for explicit approval, and each site only sees the accounts it was granted. To report a vulnerability, use the contact page with the “Developers” category.'], links: [{ label: 'Contact', href: '/contact' }] },
];
