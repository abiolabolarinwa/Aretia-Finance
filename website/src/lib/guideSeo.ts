/** Structured data for a guide page: an Article with its publisher, and a breadcrumb to /learn. `<` is escaped so the text can sit in a script tag. */
import { SITE } from './sitemap.js';

export interface GuideMeta {
  id: string;
  title: string;
  description: string;
  date: Date;
  updated?: Date;
}

export function guideJsonLd(g: GuideMeta): string {
  const url = `${SITE}/learn/${g.id}`;
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: g.title,
      description: g.description,
      datePublished: g.date.toISOString(),
      dateModified: (g.updated ?? g.date).toISOString(),
      mainEntityOfPage: url,
      author: { '@type': 'Organization', name: 'Aretia Finance' },
      publisher: { '@type': 'Organization', name: 'Aretia Finance', logo: { '@type': 'ImageObject', url: `${SITE}/assets/icons/icon-512.png` } },
      image: `${SITE}/assets/og-aretia.png`,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Aretia Finance', item: SITE },
        { '@type': 'ListItem', position: 2, name: 'Learn', item: `${SITE}/learn` },
        { '@type': 'ListItem', position: 3, name: g.title, item: url },
      ],
    },
  ];
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
