/**
 * Pay > Receive: the address to be paid at, with a QR code and a copy button, for the wallet that is connected. Nothing is sent anywhere:
 * the address is the one the wallet already shared with this page, and the QR code is drawn in the browser.
 */
import { CHAINS, type ChainId } from '../swings/core/types.js';

export interface ReceiveSources {
  /** The Solana address of the connected wallet, or null. */
  solana(): string | null;
  /** The Ethereum-style address the wallet shared, or null. */
  evm(): string | null;
}

export interface ReceiveChoice {
  chain: ChainId;
  name: string;
  address: string;
  /** What to tell the person about where this address works. */
  note: string;
}

const EVM_CHAINS = (Object.values(CHAINS) as { id: ChainId; name: string; kind: string }[]).filter((c) => c.kind === 'evm');

/** The networks that can be received on now, with the address and the plain warning for each. Pure. */
export function receiveChoices(solana: string | null, evm: string | null): ReceiveChoice[] {
  const out: ReceiveChoice[] = [];
  if (solana) out.push({ chain: 'solana', name: 'Solana', address: solana, note: 'Send only SOL and Solana tokens (SPL tokens) to this address. Assets from another network sent here can be lost.' });
  if (evm) {
    const names = EVM_CHAINS.map((c) => c.name).join(', ');
    for (const c of EVM_CHAINS) out.push({ chain: c.id, name: c.name, address: evm, note: `This one address works on ${names}. Send only assets on ${c.name} to it: an asset sent on a different network will not show up here, and may be lost.` });
  }
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function initReceive(panel: HTMLElement, src: ReceiveSources): { draw(): void } {
  let chain: ChainId | '' = '';
  async function qr(canvas: HTMLCanvasElement, text: string): Promise<void> {
    try {
      const mod = await import('qrcode');
      const toCanvas = mod.toCanvas ?? mod.default.toCanvas;
      await toCanvas(canvas, text, { width: 220, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#111114', light: '#ffffff' } });
    } catch {
      canvas.replaceWith(el('p', 'wapp__fine', 'The QR code could not be drawn here. The address above is still correct.'));
    }
  }
  function draw(): void {
    panel.replaceChildren();
    const choices = receiveChoices(src.solana(), src.evm());
    const card = el('div', 'wapp__card wapp-rx');
    card.append(el('h2', 'wapp__h2', 'Receive'));
    if (choices.length === 0) {
      card.append(el('p', 'wapp__fine', 'Connect a wallet to see the address to receive at.'));
      panel.append(card);
      return;
    }
    if (!choices.some((c) => c.chain === chain)) chain = choices[0]!.chain;
    const pick = choices.find((c) => c.chain === chain)!;
    card.append(el('p', 'wapp__fine', 'Share this address to be paid. Anyone can send to it; only your wallet can move what arrives.'));
    const label = el('label', 'wapp__eyebrow', 'Network');
    label.htmlFor = 'receive-network';
    const select = el('select', 'wapp__input');
    select.id = 'receive-network';
    for (const c of choices) {
      const o = el('option', '', c.name);
      o.value = c.chain;
      o.selected = c.chain === chain;
      select.append(o);
    }
    select.addEventListener('change', () => {
      chain = select.value as ChainId;
      draw();
    });
    const canvas = el('canvas', 'wapp-rx__qr');
    canvas.width = 220;
    canvas.height = 220;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `QR code of your ${pick.name} address`);
    const addr = el('code', 'wapp-rx__addr', pick.address);
    const copy = el('button', 'wapp__btn wapp__btn--primary', 'Copy address');
    copy.type = 'button';
    copy.addEventListener('click', () => {
      const done = (): void => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy address'), 1500);
      };
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(pick.address).then(done, () => undefined);
    });
    card.append(label, select, canvas, addr, copy, el('p', 'wapp__fine wapp-rx__note', pick.note));
    panel.append(card);
    void qr(canvas, pick.address);
  }
  return { draw };
}
