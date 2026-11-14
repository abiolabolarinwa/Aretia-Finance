/**
 * The look of the game's welcome, city and play screens: black and indigo with controlled gold, to match Aretia. Installed once, when
 * the page opens. Classes are all prefixed ucs- so they cannot touch anything else in the wallet.
 */
const CSS = `
.ucs { display: flex; flex-direction: column; gap: 22px; width: 100%; }
.ucs-fade { animation: ucs-in .45s ease both; }
@keyframes ucs-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .ucs-fade { animation: none; } .ucs * { transition: none !important; } }

.ucs-dark { position: relative; overflow: hidden; border-radius: 26px; color: #fff; border: 1px solid #2b2a72;
  background: radial-gradient(1100px 380px at 50% -12%, rgba(99, 91, 255, .38), transparent 62%), radial-gradient(700px 300px at 100% 110%, rgba(201, 162, 39, .14), transparent 60%), linear-gradient(165deg, #090912 0%, #14123a 58%, #090912 100%); }
.ucs-dark::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: linear-gradient(90deg, transparent, #c9a227, transparent); }

.ucs-hero { padding: clamp(36px, 7vw, 76px) clamp(18px, 4vw, 48px) clamp(28px, 4vw, 44px); text-align: center; }
.ucs-eyebrow { display: inline-block; letter-spacing: .2em; text-transform: uppercase; font-size: 12px; font-weight: 700; color: #d9b53a; }
.ucs-title { margin: 12px 0 10px; font-size: clamp(32px, 6vw, 60px); line-height: 1.04; font-weight: 800; letter-spacing: -.02em; }
.ucs-title span { background: linear-gradient(90deg, #f0d672, #c9a227); -webkit-background-clip: text; background-clip: text; color: transparent; }
.ucs-sub { margin: 0 auto 26px; max-width: 620px; font-size: clamp(16px, 2.3vw, 21px); color: #cfcff0; }
.ucs-play { border: 0; cursor: pointer; font-weight: 800; font-size: 19px; letter-spacing: .02em; color: #15130a; padding: 15px 56px; border-radius: 999px;
  background: linear-gradient(180deg, #e4c24a, #b8901c); box-shadow: 0 10px 34px rgba(201, 162, 39, .38), inset 0 1px 0 rgba(255, 255, 255, .45); transition: transform .15s ease, box-shadow .15s ease; }
.ucs-play:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 14px 40px rgba(201, 162, 39, .5), inset 0 1px 0 rgba(255, 255, 255, .45); }
.ucs-play:focus-visible, .ucs-btn:focus-visible, .ucs-wallet:focus-visible, .ucs-city:focus-visible, .ucs-tab:focus-visible { outline: 3px solid #8b85ff; outline-offset: 3px; }
.ucs-play:disabled { opacity: .65; cursor: default; }
.ucs-note { margin: 20px auto 0; max-width: 560px; font-size: 13px; line-height: 1.5; color: #9d9dc8; }
.ucs-msg { margin: 16px auto 0; max-width: 520px; padding: 10px 14px; border-radius: 12px; font-size: 14px; background: rgba(224, 82, 110, .16); border: 1px solid rgba(224, 82, 110, .5); color: #ffd5dd; }

.ucs-wallets { display: flex; flex-direction: column; gap: 10px; max-width: 440px; margin: 24px auto 0; }
.ucs-wallets h3 { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: #e6e6ff; }
.ucs-wallet { display: flex; align-items: center; gap: 10px; text-align: left; cursor: pointer; color: #fff; font-weight: 600; font-size: 15px; padding: 14px 18px; border-radius: 14px;
  background: rgba(67, 56, 202, .32); border: 1px solid #4a47c4; transition: background .15s, border-color .15s, transform .15s; }
.ucs-wallet:hover:not(:disabled) { background: rgba(79, 70, 229, .5); border-color: #d9b53a; transform: translateY(-1px); }
.ucs-wallet:disabled { opacity: .7; cursor: default; }
.ucs-btn { cursor: pointer; font-weight: 600; font-size: 14px; color: #e6e6ff; padding: 9px 16px; border-radius: 999px; background: transparent; border: 1px solid #4a47c4; transition: background .15s; }
.ucs-btn:hover:not(:disabled) { background: rgba(79, 70, 229, .35); }
.ucs-btn:disabled { opacity: .55; cursor: default; }

.ucs-strip { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 8px; margin-top: 38px; }
.ucs-thumb { position: relative; aspect-ratio: 3 / 4; overflow: hidden; border-radius: 12px; background: #1b1a47; border: 1px solid #2b2a72; }
.ucs-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: .85; }
.ucs-thumb span { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 4px 5px; font-size: 11px; font-weight: 700; text-align: center; color: #fff; background: linear-gradient(transparent, rgba(5, 5, 15, .92)); }

.ucs-steps { display: flex; justify-content: center; gap: 8px; margin-bottom: 22px; }
.ucs-step { padding: 5px 13px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: .04em; color: #9d9dc8; border: 1px solid #34327f; }
.ucs-step[aria-current="step"] { color: #15130a; background: linear-gradient(180deg, #e4c24a, #b8901c); border-color: transparent; }
.ucs-step.done { color: #d9b53a; border-color: #8a6f17; }

.ucs-cities { padding: clamp(24px, 4vw, 44px) clamp(14px, 3vw, 36px) clamp(26px, 4vw, 44px); }
.ucs-cities-head { text-align: center; margin-bottom: 26px; }
.ucs-cities-head h2 { margin: 6px 0 6px; font-size: clamp(26px, 4.4vw, 42px); font-weight: 800; letter-spacing: -.015em; }
.ucs-cities-head p { margin: 0; color: #cfcff0; font-size: clamp(15px, 2vw, 19px); }
.ucs-row { display: grid; gap: 14px; }
.ucs-row.five { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.ucs-row.four { grid-template-columns: repeat(4, minmax(0, 1fr)); width: 80%; margin: 14px auto 0; }
@media (max-width: 1100px) { .ucs-row.five, .ucs-row.four { grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; } .ucs-row.four { margin-top: 14px; } .ucs-strip { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
@media (max-width: 720px) { .ucs-row.five, .ucs-row.four { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ucs-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 440px) { .ucs-row.five, .ucs-row.four { grid-template-columns: minmax(0, 1fr); } }

.ucs-city { --accent: #c9a227; position: relative; display: flex; flex-direction: column; justify-content: flex-end; min-height: 330px; padding: 0; text-align: left; cursor: pointer; overflow: hidden; color: #fff;
  border-radius: 20px; border: 1px solid #2b2a72; background: #0b0b18; transition: transform .22s ease, box-shadow .22s ease, border-color .22s ease; }
.ucs-city:hover:not(:disabled) { transform: translateY(-5px); border-color: var(--accent); box-shadow: 0 18px 40px rgba(0, 0, 0, .5), 0 0 0 1px var(--accent); }
.ucs-city[aria-current="true"] { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.ucs-city:disabled { cursor: default; opacity: .72; }
.ucs-city img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform .6s ease; }
.ucs-city:hover:not(:disabled) img { transform: scale(1.06); }
.ucs-city-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(5, 5, 15, .05) 0%, rgba(5, 5, 15, .28) 38%, rgba(5, 5, 15, .94) 82%); }
.ucs-city-body { position: relative; padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 6px; }
.ucs-city-country { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
.ucs-city-name { margin: 0; font-size: 24px; font-weight: 800; line-height: 1.05; }
.ucs-city-blurb { margin: 0; font-size: 12.5px; line-height: 1.45; color: #dcdcf2; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.ucs-city-meta { font-size: 11.5px; color: #b9b9de; }
.ucs-city-go { margin-top: 6px; align-self: flex-start; font-size: 13px; font-weight: 800; padding: 8px 18px; border-radius: 999px; color: #15130a; background: var(--accent); }
.ucs-city[aria-current="true"] .ucs-city-go { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
.ucs-city:disabled .ucs-city-go { background: #3a3a6a; color: #cfcff0; }
.ucs-credit { position: relative; padding: 0 16px 9px; font-size: 9.5px; line-height: 1.3; color: rgba(255, 255, 255, .62); }

.ucs-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 20px; }
.ucs-bar-city { display: flex; align-items: center; gap: 14px; min-width: 0; }
.ucs-bar-dot { width: 12px; height: 44px; border-radius: 6px; flex: none; }
.ucs-bar h2 { margin: 0; font-size: 22px; font-weight: 800; }
.ucs-bar small { color: #b9b9de; font-size: 12.5px; }
.ucs-bar-right { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ucs-chip { padding: 7px 13px; border-radius: 999px; font-size: 12.5px; font-weight: 700; background: rgba(255, 255, 255, .08); border: 1px solid #3a38a0; }
.ucs-chip.gold { color: #f0d672; border-color: #8a6f17; }
.ucs-tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 14px; }
.ucs-tab { cursor: pointer; font-weight: 700; font-size: 14px; padding: 9px 18px; border-radius: 999px; color: #cfcff0; background: transparent; border: 1px solid transparent; transition: background .15s, color .15s; }
.ucs-tab:hover { background: rgba(79, 70, 229, .3); }
.ucs-tab[aria-selected="true"] { color: #15130a; background: linear-gradient(180deg, #e4c24a, #b8901c); }
.ucs-play-body { display: flex; flex-direction: column; gap: 14px; }
.ucs-loading { padding: 60px 20px; text-align: center; font-size: 17px; color: #cfcff0; }
`;

export function installTheme(): void {
  if (document.getElementById('ucs-theme')) return;
  const style = document.createElement('style');
  style.id = 'ucs-theme';
  style.textContent = CSS;
  document.head.append(style);
}
