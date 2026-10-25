/**
 * Styles for the tour, the resume pill and the Tours list. Injected once from script so any page can use the engine with no
 * stylesheet wiring. Colours come from the site's own variables, so light and dark follow the page theme.
 */
export const TOUR_CSS = `
.atour { position: fixed; inset: 0; z-index: 10000; pointer-events: none; font-family: var(--font-body, system-ui, sans-serif); }
.atour__block { position: fixed; inset: 0; pointer-events: auto; background: transparent; }
.atour[data-nohole] .atour__block { background: rgba(11, 11, 13, 0.6); }
.atour__hole { position: fixed; top: 0; left: 0; width: 0; height: 0; border-radius: 10px; pointer-events: none; box-shadow: 0 0 0 100vmax rgba(11, 11, 13, 0.6), 0 0 0 2px var(--color-brand-bright, #4f46e5); }
.atour[data-nohole] .atour__hole { display: none; }
.atour[data-animate] .atour__hole { transition: top 220ms ease, left 220ms ease, width 220ms ease, height 220ms ease; }
.atour__tip { position: fixed; top: 0; left: 0; box-sizing: border-box; width: 340px; max-width: calc(100vw - 24px); padding: 16px 16px 14px; pointer-events: auto; color: var(--color-text, #18181b); background: var(--color-bg, #fff); border: 1px solid var(--color-border-strong, rgba(0, 0, 0, 0.14)); border-radius: 14px; box-shadow: var(--shadow-float, 0 24px 60px -12px rgba(0, 0, 0, 0.45)); outline: none; opacity: 1; }
.atour[data-animate] .atour__tip { transition: top 220ms ease, left 220ms ease, opacity 160ms ease; }
.atour__tip[data-sheet] { top: auto !important; left: 12px !important; right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); width: auto; max-width: none; border-radius: 16px; }
.atour__meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 8px; }
.atour__count { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-muted, #5a5a60); }
.atour__dots { display: flex; gap: 4px; }
.atour__dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--color-border-strong, rgba(0, 0, 0, 0.14)); }
.atour__dots i[data-on] { background: var(--color-brand-bright, #4f46e5); }
.atour__title { margin: 0 0 6px; font-size: 15px; line-height: 1.3; font-weight: 600; color: var(--color-strong, #0b0b0d); }
.atour__body { margin: 0; font-size: 13px; line-height: 1.5; color: var(--color-text, #18181b); }
.atour__foot { display: flex; align-items: center; gap: 8px; margin: 14px 0 0; }
.atour__sp { flex: 1; }
.atour__btn { font: inherit; font-size: 13px; font-weight: 600; line-height: 1; padding: 9px 14px; border-radius: 9px; cursor: pointer; border: 1px solid var(--color-border-strong, rgba(0, 0, 0, 0.14)); color: var(--color-strong, #0b0b0d); background: transparent; }
.atour__btn:hover { background: var(--color-brand-soft, rgba(79, 70, 229, 0.08)); }
.atour__btn--primary { color: #fff; background: var(--color-brand, #3730a3); border-color: transparent; }
.atour__btn--primary:hover { background: var(--color-brand-bright, #4f46e5); }
.atour__btn--link { padding-inline: 4px; border-color: transparent; color: var(--color-muted, #5a5a60); font-weight: 500; }
.atour__btn:focus-visible { outline: 2px solid var(--color-brand-bright, #4f46e5); outline-offset: 2px; }
.atour__sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

.atour-pill { position: fixed; right: 16px; bottom: 16px; z-index: 9990; display: flex; align-items: center; gap: 2px; padding: 4px 4px 4px 4px; background: var(--color-bg, #fff); border: 1px solid var(--color-border-strong, rgba(0, 0, 0, 0.14)); border-radius: 999px; box-shadow: var(--shadow-soft, 0 12px 40px -16px rgba(0, 0, 0, 0.3)); font-family: var(--font-body, system-ui, sans-serif); }
.atour-pill .atour__btn { border: 0; border-radius: 999px; padding: 8px 12px; }
.atour-pill .atour__btn--x { padding: 8px 10px; color: var(--color-muted, #5a5a60); font-weight: 500; }

.atour-help { font: inherit; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; line-height: 1; padding: 6px 10px; border-radius: 999px; cursor: pointer; color: var(--color-strong, #0b0b0d); background: transparent; border: 1px solid var(--color-border-strong, rgba(0, 0, 0, 0.14)); }
.atour-help:hover { background: var(--color-brand-soft, rgba(79, 70, 229, 0.08)); }
.atour-help:focus-visible { outline: 2px solid var(--color-brand-bright, #4f46e5); outline-offset: 2px; }
.atour-help[hidden] { display: none; }
.atour-help b { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; font-size: 11px; color: #fff; background: var(--color-brand, #3730a3); }

.atour-menu { position: fixed; z-index: 9995; box-sizing: border-box; width: 340px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow-y: auto; padding: 14px; color: var(--color-text, #18181b); background: var(--color-bg, #fff); border: 1px solid var(--color-border-strong, rgba(0, 0, 0, 0.14)); border-radius: 14px; box-shadow: var(--shadow-float, 0 24px 60px -12px rgba(0, 0, 0, 0.45)); font-family: var(--font-body, system-ui, sans-serif); }
.atour-menu[data-sheet] { left: 12px !important; right: 12px; bottom: max(12px, env(safe-area-inset-bottom)); top: auto !important; width: auto; max-width: none; }
.atour-menu h2 { margin: 0 0 2px; font-size: 15px; font-weight: 600; color: var(--color-strong, #0b0b0d); }
.atour-menu > p { margin: 0 0 10px; font-size: 12px; color: var(--color-muted, #5a5a60); }
.atour-menu ul { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.atour-menu li { display: flex; align-items: center; gap: 10px; padding: 8px 6px; border-radius: 10px; }
.atour-menu li:hover { background: var(--color-brand-soft, rgba(79, 70, 229, 0.08)); }
.atour-menu__text { flex: 1; min-width: 0; }
.atour-menu__text strong { display: block; font-size: 13px; font-weight: 600; color: var(--color-strong, #0b0b0d); }
.atour-menu__text span { display: block; font-size: 12px; color: var(--color-muted, #5a5a60); }
.atour-menu__text span[data-done] { color: var(--color-ok, #1b8a4b); }

@media (prefers-reduced-motion: reduce) {
  .atour[data-animate] .atour__hole, .atour[data-animate] .atour__tip { transition: none; }
}
`;

let injected = false;

export function injectTourStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-atour-css', '');
  s.textContent = TOUR_CSS;
  document.head.append(s);
}
