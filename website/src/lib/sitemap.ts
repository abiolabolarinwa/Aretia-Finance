/**
 * The site's sitemap: the public pages and the published blog posts, so search engines find them. Pure; the endpoint (pages/sitemap.xml.ts)
 * supplies the posts. Pages that are not for the public (the owner page, the 404, search results) are never listed.
 */
export const SITE = 'https://aretiafinance.org';

/** Paths of the pages worth finding, in the order they are listed. `/` is only a jump to Markets, so Markets and the home page are listed instead. */
export const PUBLIC_PAGES: readonly string[] = ['/wallet', '/home', '/about', '/features', '/faq', '/featured', '/verified', '/carboncredit', '/advertise', '/blog', '/support', '/contact', '/privacy', '/terms'];

export interface SitemapPost {
  id: string;
  date: Date;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildSitemap(posts: readonly SitemapPost[], pages: readonly string[] = PUBLIC_PAGES): string {
  const urls = [
    ...pages.map((p) => `  <url><loc>${esc(SITE + p)}</loc></url>`),
    ...posts.map((p) => `  <url><loc>${esc(`${SITE}/blog/${p.id}`)}</loc><lastmod>${p.date.toISOString().slice(0, 10)}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
