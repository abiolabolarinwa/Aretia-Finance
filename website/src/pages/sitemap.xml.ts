import type { APIRoute } from 'astro';
import { getPublishedPosts } from '../lib/blog';
import { buildSitemap } from '../lib/sitemap';

export const GET: APIRoute = async () => {
  const posts = await getPublishedPosts();
  return new Response(buildSitemap(posts.map((p) => ({ id: p.id, date: p.data.date }))), { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};
