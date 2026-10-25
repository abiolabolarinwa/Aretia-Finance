import type { TourConfig, TourStep } from './types';

/**
 * The wallet's tours. Plain data only (no DOM), so it can be tested and edited without touching the engine.
 * `view` is the wallet page a step needs: dashboard, send, swap, swings, launch, launchbox.
 * Raise a tour's `version` after changing its steps and everyone sees it once more.
 */

/** Shown first on pages that need a wallet, only while the "Connect your wallet" box is on screen. */
const connectFirst = (what: string): TourStep => ({
  target: '[data-gate] [data-connect]',
  title: 'Connect a wallet first',
  body: `${what} needs a wallet. Connect the Solana wallet you already use. Aretia only reads public data, and your own wallet asks you before anything moves.`,
  placement: 'bottom',
});

export const WALLET_WELCOME_ID = 'wallet-welcome';
export const WALLET_CONNECT_ID = 'wallet-connect';

export const WALLET_TOURS: TourConfig[] = [
  {
    id: WALLET_CONNECT_ID,
    title: 'Getting started',
    version: 1,
    hidden: true,
    steps: [
      {
        view: 'dashboard',
        title: 'Welcome to Aretia',
        body: 'A quick look around, about a minute. Your own wallet signs everything. Aretia never holds your keys or your recovery phrase.',
      },
      {
        target: '[data-connect], [data-aretia-wallet-mount] button',
        title: 'Connect your wallet',
        body: 'Connect Phantom, Solflare, Backpack or another Solana wallet. Connecting lets this page read your public balances. It cannot move anything on its own.',
        placement: 'bottom',
      },
      {
        target: '#wapp-nav',
        title: 'Look around first',
        body: 'Markets, Radar and Shield work without a wallet. Pay, Swap and Launch ask you to connect when you need them.',
        placement: 'right',
      },
    ],
  },
  {
    id: WALLET_WELCOME_ID,
    title: 'Wallet basics',
    description: 'A one-minute look around your wallet.',
    version: 1,
    steps: [
      {
        view: 'dashboard',
        title: 'You are connected',
        body: 'This is your wallet page. Your own wallet signs everything, and Aretia never holds your keys. Here is a short look around.',
      },
      {
        target: '.wapp-dash__hero',
        title: 'Your balance',
        body: 'The total value of what this wallet holds, read from public data. Nothing on this page can move your money without your approval.',
        placement: 'bottom',
      },
      {
        target: '#wapp-nav',
        title: 'Everything is in the sidebar',
        body: 'Markets and Swap to trade, Pay to send, Launch to create a token, Shield to check a token before you buy.',
        placement: 'right',
      },
      {
        target: '.wapp-dash__services',
        title: 'Shortcuts',
        body: 'The main things you can do, one tap away. Each page has a "Take a tour" button if you want a closer look.',
        placement: 'top',
      },
      {
        target: '[data-lock]',
        title: 'Lock this wallet',
        body: 'Optional. Protect the wallet on this computer with a password, a PIN or your computer’s own unlock.',
        placement: 'right',
      },
      {
        target: '[data-tour-menu]',
        title: 'Tours live here',
        body: 'Open Tours any time to replay this one or take a closer tour of Swap, Markets, Launch, Pay or Launch Box.',
        placement: 'right',
      },
    ],
  },
  {
    id: 'tour-swap',
    title: 'Swap',
    description: 'Trade one token for another.',
    version: 1,
    steps: [
      { view: 'swap', target: '.wapp__rail', title: 'Pick a network', body: 'These are the networks you can trade on. A network that is switched off is marked.', placement: 'right' },
      { target: '.wapp__swap .wapp__swap-box', title: 'What you pay', body: 'Choose the token you pay with and type an amount. Use the quick buttons to fill in a share of your balance.', placement: 'bottom' },
      { target: '.wapp__swap-flip', title: 'Switch sides', body: 'Swap the two tokens round if you want to go the other way.', placement: 'right' },
      { target: '.wapp__swap-more', title: 'See the cost first', body: 'Details shows the quote, the least you will receive and every fee. You see all of it before anything is signed. Quotes run out after a short time.', placement: 'top' },
      { target: '.wapp__swap .wapp__btn--primary', title: 'Your wallet signs it', body: 'Press the button and your wallet shows the transaction. You approve it there. Aretia never holds your keys.', placement: 'top' },
      { target: '.wapp__chart', title: 'The price', body: 'The chart shows the pair you picked. A token being listed is not a recommendation: check the address and the safety notes before you buy.', placement: 'left' },
    ],
  },
  {
    id: 'tour-markets',
    title: 'Markets',
    description: 'Find, watch and open tokens.',
    version: 1,
    steps: [
      { view: 'swings', target: '[data-wapp-search]', title: 'Search any token', body: 'Type a name, a symbol or a contract address.', placement: 'bottom' },
      { target: '.wapp__rail', title: 'Choose a network', body: 'Switch networks to see their tokens. Greyed out ones are switched off for now.', placement: 'right' },
      { target: '.wapp-mt__bar', title: 'Filter the list', body: 'Narrow the list down to what you want to look at.', placement: 'bottom' },
      { target: '.wapp-mt__table', title: 'The list', body: 'Sort by any column. Press a row to open the token, with its chart and safety notes.', placement: 'top' },
      { target: '.wapp-mt__star', title: 'Keep an eye on it', body: 'Star a token to add it to Favourites.', placement: 'right' },
      { target: '.wapp-island', title: 'New tokens', body: 'Aretia watches for newly launched tokens and tells you here.', placement: 'bottom' },
      { target: '[data-markets-swap]', title: 'Ready to trade?', body: 'Open Swap. You see the quote and every fee before your wallet is asked to sign.', placement: 'bottom' },
    ],
  },
  {
    id: 'tour-pay',
    title: 'Pay',
    description: 'Send tokens, or move money in and out.',
    version: 1,
    steps: [
      { view: 'send', ...connectFirst('Pay') },
      { target: '.wapp-pay__hub', title: 'Three ways to pay', body: 'Send a token to an address, cash out or top up with USDC, or move USDC from one network to another.', placement: 'bottom' },
      { target: '[data-send-asset]', title: 'What to send', body: 'Pick SOL or any token you hold.', placement: 'bottom' },
      { target: '[data-send-to]', title: 'Who gets it', body: 'Paste an address or type a .sns name. Check the full address: transfers cannot be reversed.', placement: 'bottom' },
      { target: '[data-send-amount]', title: 'How much', body: 'Type an amount, or press Max. Some tokens take a fee on every move, so the receiver can get slightly less.', placement: 'bottom' },
      { target: '[data-send-form] button[type="submit"]', title: 'Review before you sign', body: 'Review shows the whole transaction first. Then your own wallet asks you to approve it. Aretia never holds your keys.', placement: 'top' },
    ],
  },
  {
    id: 'tour-launch',
    title: 'Launch',
    description: 'Create a token and give it a market.',
    version: 1,
    steps: [
      { view: 'launch', ...connectFirst('Launch') },
      { target: '[data-hub-networks]', title: 'Pick a network', body: 'Choose where your token will live. Fees are shown before you sign.', placement: 'bottom' },
      { target: '[data-hub-rail]', title: 'Three steps', body: 'Create your token, give it a market, then it is live and anyone can buy it. You can see where you are at any time.', placement: 'bottom' },
      { target: '[data-launch-root]', title: 'Create your token', body: 'Fill in the name, symbol and supply. Your wallet signs the creation. Aretia never holds your keys.', placement: 'right' },
      { target: '[data-hub-rail] .lh-step:nth-child(2)', title: 'Give it a market', body: 'A market, a pool or a bonding curve, lets people buy and sell it. The cost is shown before you sign.', placement: 'bottom' },
      { target: '[data-hub-open-pools]', title: 'Your pools and fees', body: 'Come back here to see the pools you made and any fees you can collect.', placement: 'top' },
      { target: '[data-promote-open]', title: 'Promote it', body: 'Optional. Request a featured spot so more people see your token.', placement: 'top' },
    ],
  },
  {
    id: 'tour-launchbox',
    title: 'Launch Box',
    description: 'Browse tokens launched with Aretia.',
    version: 1,
    steps: [
      { view: 'launchbox', target: '.wapp-lb__bar .wapp__seg', title: 'Sort the list', body: 'See the newest tokens, the trending ones, or only those on a curve or on a pool.', placement: 'bottom' },
      { target: '.wapp-lb__bar .wapp__seg:nth-of-type(2)', title: 'Pick a network', body: 'Show every network, or just one.', placement: 'bottom' },
      { target: '.wapp-lb__bar input', title: 'Search', body: 'Look a token up by name or symbol.', placement: 'bottom' },
      { target: '.wapp-lb__list', title: 'Open a token', body: 'Each row is a token launched through Aretia. Press one for its public page. Listing is not a recommendation: check it before you buy.', placement: 'top' },
    ],
  },
];

/** Which tour the "Take a tour" button on a wallet page starts. */
export const VIEW_TOUR: Record<string, string> = {
  swap: 'tour-swap',
  swings: 'tour-markets',
  send: 'tour-pay',
  launch: 'tour-launch',
  launchbox: 'tour-launchbox',
};
