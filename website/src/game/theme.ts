/**
 * The look of the game's welcome, city and play screens: black and white, to match Aretia's wallet. Installed once, when the page
 * opens. Classes are all prefixed ucs- so they cannot touch anything else in the wallet. Colours are set on the elements themselves
 * (with the .ucs-dark prefix) so the wallet's own heading and button styles cannot turn white text dark.
 */
const CSS = `
.ucs { display: flex; flex-direction: column; gap: 22px; width: 100%; }
.ucs-fade { animation: ucs-in .45s ease both; }
@keyframes ucs-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .ucs-fade { animation: none; } .ucs * { transition: none !important; } }

.ucs-dark { position: relative; overflow: hidden; border-radius: 26px; color: #fff; border: 1px solid #262626;
  background: radial-gradient(900px 320px at 50% -14%, rgba(255, 255, 255, .09), transparent 62%), linear-gradient(170deg, #000 0%, #0b0b0b 60%, #000 100%); }
.ucs-dark h1, .ucs-dark h2, .ucs-dark h3, .ucs-dark p, .ucs-dark span, .ucs-dark small, .ucs-dark div { color: inherit; }
.ucs-dark h1, .ucs-dark h2, .ucs-dark h3 { color: #fff; }

.ucs-hero { padding: clamp(36px, 7vw, 76px) clamp(18px, 4vw, 48px) clamp(28px, 4vw, 44px); text-align: center; }
.ucs-dark .ucs-eyebrow { display: inline-block; letter-spacing: .22em; text-transform: uppercase; font-size: 12px; font-weight: 700; color: #a3a3a3; }
.ucs-dark .ucs-title { margin: 12px 0 10px; font-size: clamp(32px, 6vw, 60px); line-height: 1.04; font-weight: 800; letter-spacing: -.02em; color: #fff; }
.ucs-dark .ucs-sub { margin: 0 auto 26px; max-width: 620px; font-size: clamp(16px, 2.3vw, 21px); color: #d4d4d4; }
.ucs-dark .ucs-play { border: 0; cursor: pointer; font-weight: 800; font-size: 19px; letter-spacing: .02em; color: #000; padding: 15px 56px; border-radius: 999px;
  background: #fff; box-shadow: 0 8px 30px rgba(255, 255, 255, .16); transition: transform .15s ease, box-shadow .15s ease, background .15s; }
.ucs-dark .ucs-play:hover:not(:disabled) { transform: translateY(-2px); background: #f2f2f2; box-shadow: 0 12px 38px rgba(255, 255, 255, .26); }
.ucs-play:focus-visible, .ucs-btn:focus-visible, .ucs-wallet:focus-visible, .ucs-city:focus-visible, .ucs-tab:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
.ucs-play:disabled { opacity: .65; cursor: default; }
.ucs-dark .ucs-note { margin: 20px auto 0; max-width: 560px; font-size: 13px; line-height: 1.5; color: #8f8f8f; }
.ucs-dark .ucs-msg { margin: 16px auto 0; max-width: 520px; padding: 10px 14px; border-radius: 12px; font-size: 14px; background: rgba(255, 255, 255, .06); border: 1px solid #5a5a5a; color: #fff; }

.ucs-wallets { display: flex; flex-direction: column; gap: 10px; max-width: 440px; margin: 24px auto 0; }
.ucs-dark .ucs-wallets h3 { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #e5e5e5; }
.ucs-dark .ucs-wallet { display: flex; align-items: center; gap: 14px; text-align: left; cursor: pointer; color: #fff; font-weight: 700; font-size: 16px; padding: 12px 18px; border-radius: 16px; width: 100%;
  background: #111; border: 1px solid #333; transition: background .15s, border-color .15s, transform .15s; }
.ucs-dark .ucs-wallet:hover:not(:disabled) { background: #1a1a1a; border-color: #fff; transform: translateY(-1px); }
.ucs-dark .ucs-wallet:disabled { opacity: .7; cursor: default; }
.ucs-wallet img { width: 34px; height: 34px; border-radius: 9px; flex: none; object-fit: cover; }
.ucs-wallet small { display: block; font-weight: 500; font-size: 12px; color: #8f8f8f; }
.ucs-dark .ucs-btn { cursor: pointer; font-weight: 600; font-size: 14px; color: #fff; padding: 9px 16px; border-radius: 999px; background: transparent; border: 1px solid #444; transition: background .15s; }
.ucs-dark .ucs-btn:hover:not(:disabled) { background: #1c1c1c; border-color: #fff; }
.ucs-btn:disabled { opacity: .55; cursor: default; }
.ucs-qr { display: flex; flex-direction: column; align-items: center; gap: 12px; margin: 22px auto 0; }
.ucs-qr img { width: 240px; height: 240px; padding: 10px; background: #fff; border-radius: 16px; }
.ucs-qr-row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }

.ucs-strip { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 8px; margin-top: 38px; }
.ucs-thumb { position: relative; aspect-ratio: 3 / 4; overflow: hidden; border-radius: 12px; background: #111; border: 1px solid #262626; }
.ucs-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: .88; }
.ucs-dark .ucs-thumb span { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 4px 5px; font-size: 11px; font-weight: 700; text-align: center; color: #fff; background: linear-gradient(transparent, rgba(0, 0, 0, .92)); }

.ucs-steps { display: flex; justify-content: center; gap: 8px; margin-bottom: 22px; }
.ucs-dark .ucs-step { padding: 5px 13px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: .04em; color: #8f8f8f; border: 1px solid #333; }
.ucs-dark .ucs-step[aria-current="step"] { color: #000; background: #fff; border-color: #fff; }
.ucs-dark .ucs-step.done { color: #fff; border-color: #666; }

.ucs-cities { padding: clamp(24px, 4vw, 44px) clamp(14px, 3vw, 36px) clamp(26px, 4vw, 44px); }
.ucs-cities-head { text-align: center; margin-bottom: 26px; }
.ucs-dark .ucs-cities-head h2 { margin: 6px 0 6px; font-size: clamp(26px, 4.4vw, 42px); font-weight: 800; letter-spacing: -.015em; color: #fff; }
.ucs-dark .ucs-cities-head p { margin: 0; color: #d4d4d4; font-size: clamp(15px, 2vw, 19px); }
.ucs-row { display: grid; gap: 14px; }
.ucs-row.five { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.ucs-row.four { grid-template-columns: repeat(4, minmax(0, 1fr)); width: 80%; margin: 14px auto 0; }
@media (max-width: 1100px) { .ucs-row.five, .ucs-row.four { grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; } .ucs-row.four { margin-top: 14px; } .ucs-strip { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
@media (max-width: 720px) { .ucs-row.five, .ucs-row.four { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ucs-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 440px) { .ucs-row.five, .ucs-row.four { grid-template-columns: minmax(0, 1fr); } }

.ucs-dark .ucs-city { position: relative; display: flex; flex-direction: column; justify-content: flex-end; min-height: 330px; padding: 0; text-align: left; cursor: pointer; overflow: hidden; color: #fff;
  border-radius: 20px; border: 1px solid #2a2a2a; background: #0a0a0a; transition: transform .22s ease, box-shadow .22s ease, border-color .22s ease; }
.ucs-dark .ucs-city:hover:not(:disabled) { transform: translateY(-5px); border-color: #fff; box-shadow: 0 18px 40px rgba(0, 0, 0, .7); }
.ucs-dark .ucs-city[aria-current="true"] { border-color: #fff; box-shadow: 0 0 0 2px #fff; }
.ucs-city:disabled { cursor: default; opacity: .72; }
.ucs-city img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform .6s ease; }
.ucs-city:hover:not(:disabled) img { transform: scale(1.06); }
.ucs-city-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0, 0, 0, .05) 0%, rgba(0, 0, 0, .3) 38%, rgba(0, 0, 0, .95) 82%); }
.ucs-city-body { position: relative; padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 6px; }
.ucs-dark .ucs-city-country { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #bdbdbd; }
.ucs-dark .ucs-city-name { margin: 0; font-size: 24px; font-weight: 800; line-height: 1.05; color: #fff; }
.ucs-dark .ucs-city-blurb { margin: 0; font-size: 12.5px; line-height: 1.45; color: #e0e0e0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.ucs-dark .ucs-city-meta { font-size: 11.5px; color: #b5b5b5; }
.ucs-dark .ucs-city-go { margin-top: 6px; align-self: flex-start; font-size: 13px; font-weight: 800; padding: 8px 18px; border-radius: 999px; color: #000; background: #fff; }
.ucs-dark .ucs-city[aria-current="true"] .ucs-city-go { background: transparent; color: #fff; border: 1px solid #fff; }
.ucs-dark .ucs-city:disabled .ucs-city-go { background: #333; color: #d4d4d4; }
.ucs-dark .ucs-credit { position: relative; padding: 0 16px 9px; font-size: 9.5px; line-height: 1.3; color: rgba(255, 255, 255, .62); }

.ucs-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 20px; }
.ucs-bar-city { display: flex; align-items: center; gap: 14px; min-width: 0; }
.ucs-bar-dot { width: 6px; height: 44px; border-radius: 6px; flex: none; background: #fff; }
.ucs-dark .ucs-bar h2 { margin: 0; font-size: 22px; font-weight: 800; color: #fff; }
.ucs-dark .ucs-bar small { color: #a3a3a3; font-size: 12.5px; }
.ucs-bar-right { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ucs-dark .ucs-chip { padding: 7px 13px; border-radius: 999px; font-size: 12.5px; font-weight: 700; color: #fff; background: #151515; border: 1px solid #333; }
.ucs-tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 14px; }
.ucs-dark .ucs-tab { cursor: pointer; font-weight: 700; font-size: 14px; padding: 9px 18px; border-radius: 999px; color: #d4d4d4; background: transparent; border: 1px solid transparent; transition: background .15s, color .15s; }
.ucs-dark .ucs-tab:hover { background: #1a1a1a; }
.ucs-dark .ucs-tab[aria-selected="true"] { color: #000; background: #fff; }
.ucs-play-body { display: flex; flex-direction: column; gap: 14px; }
.ucs-dark .ucs-loading { padding: 60px 20px; text-align: center; font-size: 17px; color: #d4d4d4; }
`;

export function installTheme(): void {
  const old = document.getElementById('ucs-theme');
  if (old) {
    old.textContent = CSS;
    return;
  }
  const style = document.createElement('style');
  style.id = 'ucs-theme';
  style.textContent = CSS;
  document.head.append(style);
}
