/**
 * Live ACT price from the ACT/USDC pool via DexScreener. Elements are hidden until a price arrives;
 * a failed fetch leaves the last value (or nothing) rather than showing a made-up number.
 * Markup contract: [data-act-price][data-pair] containing [data-price-value] and optional [data-price-change].
 */
const fmtPrice = (n: number) =>
  '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(n >= 0.01 ? 4 : 5).replace(/0+$/, '').replace(/\.$/, ''));

export function initActPrice(root: ParentNode = document): void {
  const els = [...root.querySelectorAll<HTMLElement>('[data-act-price]')];
  if (!els.length) return;
  const load = async () => {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${els[0].dataset.pair}`);
      if (!res.ok) return;
      const pair = (await res.json())?.pairs?.[0];
      const price = Number(pair?.priceUsd);
      if (!Number.isFinite(price) || price <= 0) return;
      const chg = Number(pair?.priceChange?.h24);
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
