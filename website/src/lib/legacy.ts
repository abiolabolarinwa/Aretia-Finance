/**
 * Serves the pre-redesign functional pages (presale, stake, verify, apply…)
 * inside the new site shell without rewriting their logic. At build time
 * each source in legacy/pages/ is split into:
 *   - its content (everything between the old top nav and the old footer),
 *   - its scripts (kept byte-for-byte, so wallet, RPC and form logic is untouched),
 *   - its CSS, scoped under `.legacy` and re-themed to the dark palette by
 *     remapping the page's own design variables.
 */
import postcss, { type Rule } from 'postcss';

export interface LegacyPage {
  title: string;
  description: string;
  css: string;
  content: string;
  scripts: string;
}

// Bundled by Vite at build time, so this works regardless of the process's working directory.
const SOURCES = import.meta.glob<string>('../../legacy/pages/*.html', { query: '?raw', import: 'default', eager: true });

/** Site-palette values for the legacy pages' own design variables (Apple-style light system). */
const THEME_VARS = `
  --ink: #1d1d1f; --ink-soft: #6e6e73; --ink-faint: #86868b;
  --bg: #ffffff; --bg-alt: #f5f5f7; --card: #ffffff;
  --border: #d2d2d7; --border-soft: #e8e8ed;
  --black: #1d1d1f; --black-hover: #3a3a3c;
  --brand: #0b3d2e; --brand-hover: #072a20; --brand-soft: rgba(11, 61, 46,0.06);
  --font-sans: 'Geist Variable', system-ui, sans-serif;
  --font-serif: 'Geist Variable', system-ui, sans-serif;
  --mono: ui-monospace, 'SF Mono', Menlo, monospace;
  background: transparent; color: var(--ink);
`;

const LIGHT_BACKGROUNDS: Record<string, string> = {
  '#fff': 'var(--card)',
  '#ffffff': 'var(--card)',
  white: 'var(--card)',
  '#faf9f5': 'var(--bg)',
  '#f2f0ea': 'var(--bg-alt)',
  '#efeff3': 'var(--border-soft)',
  '#e7e7ec': 'var(--border)',
};

// Rules that only style the old nav/footer: drop them, their markup is gone.
const DROP_SELECTOR = /(^|[\s,>+~])footer\b|\.footer[-_\w]*|topnav|gooey|brand-word|\.bw-\d|nav-cta/;

function scopeSelector(sel: string): string {
  const s = sel.trim();
  if (s === ':root' || s === 'html' || s === 'body') return '.legacy';
  if (/^(html|body)\b/.test(s)) return s.replace(/^(html|body)/, '.legacy');
  if (s.startsWith('::selection')) return `.legacy ${s}`;
  return `.legacy ${s}`;
}

function transformCss(css: string): string {
  const root = postcss.parse(css);
  root.walkRules((rule: Rule) => {
    const parent = rule.parent;
    if (parent && parent.type === 'atrule' && /keyframes$/i.test((parent as { name: string }).name)) return;
    const kept = rule.selectors.filter((s) => !DROP_SELECTOR.test(s));
    if (kept.length === 0) {
      rule.remove();
      return;
    }
    rule.selectors = kept.map(scopeSelector);
    // Small caps-and-tracking labels read as template eyebrows: set them in sentence case.
    const upper = rule.nodes.some((n) => n.type === 'decl' && n.prop === 'text-transform' && n.value === 'uppercase');
    if (upper) {
      rule.walkDecls((decl) => {
        if (decl.prop === 'text-transform') decl.remove();
        else if (decl.prop === 'letter-spacing' && parseFloat(decl.value) > 0) decl.value = '-0.005em';
      });
    }
    // UI transitions answer inside 300ms with a strong ease-out.
    rule.walkDecls(/^transition(-duration)?$/, (decl) => {
      decl.value = decl.value
        .replace(/(\d+)ms/g, (m, n) => (Number(n) > 300 ? '240ms' : m))
        .replace(/\bease(-out|-in-out)?\b(?!-)/g, 'var(--ease-out)');
    });
    rule.walkDecls(/^background(-color)?$/, (decl) => {
      decl.value = decl.value.replace(/#fff(fff)?\b|\bwhite\b|#faf9f5|#f2f0ea|#efeff3|#e7e7ec/gi, (m) => LIGHT_BACKGROUNDS[m.toLowerCase()] ?? m);
    });
  });
  // Hover effects only on devices with a real pointer, so they never stick after a tap.
  root.walkRules((rule: Rule) => {
    const parent = rule.parent;
    if (!rule.selector.includes(':hover') || (parent && parent.type === 'atrule')) return;
    const media = postcss.atRule({ name: 'media', params: '(hover: hover) and (pointer: fine)' });
    rule.replaceWith(media);
    media.append(rule);
  });
  // The page's own :root variables now live on .legacy; the site palette comes last so it wins.
  return `${root.toString()}
.legacy { ${THEME_VARS} }
.legacy h1, .legacy h2, .legacy h3 { font-family: var(--font-display); font-weight: 600; letter-spacing: -0.03em; }
.legacy ::selection { background: rgba(15, 107, 75, 0.16); color: var(--color-strong); }
.legacy :focus-visible { outline: 2px solid var(--color-brand-bright); outline-offset: 3px; }
.legacy button:active, .legacy .btn:active { transform: scale(0.97); }
/* Keep the pastel aurora hero as a soft wash, not a loud gradient. */
.legacy .dhero, .legacy .mp-hero { background: transparent; padding-top: calc(var(--nav-height) + 64px); }
.legacy .dhero-ribbon, .legacy .mp-hero-ribbon { opacity: 0.22; filter: saturate(60%) blur(90px); }
.legacy .dhero-wash, .legacy .mp-hero-wash { opacity: 0.45; }
.legacy .dhero-grain, .legacy .mp-hero-grain { opacity: 0.03; }
.legacy [id] { scroll-margin-top: calc(var(--nav-height) + 16px); }
/* Pre-existing: roadmap's 1fr column couldn't shrink below its content on phones. */
.legacy .phase { grid-template-columns: 44px minmax(0, 1fr); }
.legacy .item-list { grid-template-columns: minmax(0, 1fr); }
.legacy .item-list li { overflow-wrap: anywhere; }
.legacy .item-list li > * { min-width: 0; }`;
}

function sliceBetween(html: string, start: number, end: number): string {
  return html.slice(start, end).replace(/(src|href)="assets\//g, '$1="/assets/');
}

/** Index just past the old top nav, which itself contains a nested <nav>. */
function endOfTopNav(html: string): number {
  const start = html.indexOf('<nav class="topnav');
  if (start < 0) throw new Error('legacy page has no top nav');
  let depth = 0;
  const re = /<nav\b|<\/nav>/g;
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === '</nav>' ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  throw new Error('unbalanced top nav');
}

/**
 * The presale was cancelled (1 Oct 2026). Removes the old "Presale opens in"
 * countdown popup, a <div id="presale-countdown-overlay"> with nested divs,
 * from a page's markup.
 */
function stripPresaleCountdown(html: string): string {
  const start = html.indexOf('<div id="presale-countdown-overlay"');
  if (start < 0) return html;
  let depth = 0;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(0, start) + html.slice(m.index + m[0].length);
  }
  return html;
}

/** Removes the label-above-the-heading elements; the headings carry themselves. */
function stripEyebrows(html: string): string {
  return html.replace(/<(p|span|div)\s+class="(?:[\w-]*-)?(?:eyebrow|kicker)"[^>]*>(?:(?!<\1\b)[\s\S])*?<\/\1>\s*/g, '');
}

export function loadLegacyPage(name: string): LegacyPage {
  const html = SOURCES[`../../legacy/pages/${name}.html`];
  if (!html) throw new Error(`No legacy page source named "${name}"`);
  const title = (html.match(/<title>([^<]*)<\/title>/)?.[1] ?? name).replace(/\s*·\s*Aretia.*$/, '').trim();
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

  const bodyStart = html.indexOf('<body>') + '<body>'.length;
  const navStart = html.indexOf('<nav class="topnav');
  const navEnd = endOfTopNav(html);
  const footerStart = html.indexOf('<footer', navEnd);
  const footerEnd = html.indexOf('</footer>', footerStart) + '</footer>'.length;
  const bodyEnd = html.lastIndexOf('</body>');

  const content = sliceBetween(html, bodyStart, navStart) + sliceBetween(html, navEnd, footerStart);
  const scripts = sliceBetween(html, footerEnd, bodyEnd)
    // Handled by the new layout: footer animation and analytics.
    .replace(/<script[^>]*src="\/assets\/footer-bars\.js"[^>]*><\/script>/g, '')
    .replace(/<script[^>]*src="\/_vercel\/insights\/script\.js"[^>]*><\/script>/g, '')
    // The cancelled presale's countdown popup script.
    .replace(/<script>(?:(?!<\/script>)[\s\S])*PRESALE_OPEN[\s\S]*?<\/script>/g, '');

  return { title, description, css: transformCss(style), content: stripEyebrows(stripPresaleCountdown(content)), scripts };
}
