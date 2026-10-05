/**
 * Live ACT price from the ACT/USDC pool via DexScreener, falling back to GeckoTerminal (same pool, read from
 * the chain) when DexScreener has no pair. Elements are hidden until a price arrives;
 * a failed fetch leaves the last value (or nothing) rather than showing a made-up number.
 * Markup contract: [data-act-price][data-pair] containing [data-price-value] and optional [data-price-change].
 */
interface Quote {
  price: number;
  change: number;
}

async function fromDexScreener(pair: string): Promise<Quote | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pair}`);
  if (!res.ok) return null;
  const p = (await res.json())?.pairs?.[0];
  const price = Number(p?.priceUsd);
  return Number.isFinite(price) && price > 0 ? { price, change: Number(p?.priceChange?.h24) } : null;
}

async function fromGeckoTerminal(pair: string): Promise<Quote | null> {
  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair}`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const a = (await res.json())?.data?.attributes;
  const price = Number(a?.base_token_price_usd);
  return Number.isFinite(price) && price > 0 ? { price, change: Number(a?.price_change_percentage?.h24) } : null;
}

const fmtPrice = (n: number) =>
  '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(n >= 0.01 ? 4 : 5).replace(/0+$/, '').replace(/\.$/, ''));

export function initActPrice(root: ParentNode = document): void {
  const els = [...root.querySelectorAll<HTMLElement>('[data-act-price]')];
  if (!els.length) return;
  const load = async () => {
    try {
      const pair = els[0].dataset.pair ?? '';
      let quote: Quote | null = null;
      try {
        quote = await fromDexScreener(pair);
      } catch {
        quote = null;
      }
      quote ??= await fromGeckoTerminal(pair);
      if (!quote) return;
      const { price, change: chg } = quote;
      for (const el of els) {
        el.querySelector('[data-price-value]')!.textContent = fmtPrice(price);
        const chgEl = el.querySelector<HTMLElement>('[data-price-change]');
        if (chgEl && Number.isFinite(chg)) {
          chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
          chgEl.classList.toggle('is-up', chg > 0);
          chgEl.classList.toggle('is-down', chg < 0);
        }
        el.hidden = false;
      }
    } catch {
      /* offline or rate-limited: keep whatever is shown */
    }
  };
  void load();
  window.setInterval(() => !document.hidden && void load(), 60_000);
}
