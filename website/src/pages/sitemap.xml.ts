import type { APIRoute } from 'astro';
import { getPublishedPosts } from '../lib/blog';
import { getGuides } from '../lib/guides';
import { PUBLIC_PAGES } from '../lib/sitemap';
import { buildSitemap } from '../lib/sitemap';

export const GET: APIRoute = async () => {
  const [posts, guides] = await Promise.all([getPublishedPosts(), getGuides()]);
  return new Response(buildSitemap(posts.map((p) => ({ id: p.id, date: p.data.date })), PUBLIC_PAGES, guides.map((g) => ({ id: g.id, date: g.data.updated ?? g.data.date }))), { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
