import { getCollection, type CollectionEntry } from 'astro:content';

export async function getGuides(): Promise<CollectionEntry<'guides'>[]> {
  const guides = await getCollection('guides', ({ data }) => !data.draft);
  return guides.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}
