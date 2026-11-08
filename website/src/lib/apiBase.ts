/**
 * The native apps (Android and iPhone) load this site from inside the app, so a relative "/api/..." call would go to the
 * app instead of Aretia. When the app is built with PUBLIC_API_BASE set (for example https://aretiafinance.org), this
 * small script, placed in the page head, sends every same-origin "/api/..." fetch to that address instead. On the website
 * the variable is empty and the script is not added at all.
 *
 * It is kept as a string so the page can inline it ahead of every other script, and so a test can run the very same code.
 */
export const API_SHIM_SOURCE = `(function (base) {
  if (!base || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  var original = window.fetch;
  function isApi(u) { return u.origin === window.location.origin && u.pathname.indexOf('/api/') === 0; }
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string') {
        if (input.indexOf('/api/') === 0) input = base + input;
      } else if (typeof URL !== 'undefined' && input instanceof URL) {
        if (isApi(input)) input = new URL(base + input.pathname + input.search);
      } else if (typeof Request !== 'undefined' && input instanceof Request) {
        var u = new URL(input.url);
        if (isApi(u)) input = new Request(base + u.pathname + u.search, input);
      }
    } catch (e) { /* leave the call as it was */ }
    return original.call(this, input, init);
  };
})`;

/** The inline script for the page head, or null when no API address is configured (the website). */
export function apiShimScript(base: string | undefined): string | null {
  const b = (base ?? '').trim().replace(/\/+$/, '');
  if (!b) return null;
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(b)) throw new Error('PUBLIC_API_BASE must be an https origin such as https://aretiafinance.org');
  return `${API_SHIM_SOURCE}(${JSON.stringify(b)});`;
}
