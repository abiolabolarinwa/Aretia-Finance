/**
 * Finds freely licensed photographs of the cities on Wikimedia Commons, with the licence and author that Commons records, so a city
 * card can show a real photograph with its credit. It only lists candidates and writes SQL; a person looks at a photograph before it
 * is used, and nothing is applied to the database by this script.
 *
 *   node scripts/game-city-photos.ts search "Eiffel Tower Paris"      list candidates for a search
 *   node scripts/game-city-photos.ts sql paris "File:Some photo.jpg"  SQL that sets one city's photograph and credit
 *
 * Only licences that allow commercial reuse with credit are accepted: CC BY, CC BY-SA (any version), CC0 and the public domain.
 * NonCommercial and NoDerivatives licences are refused.
 */
import { pathToFileURL } from 'node:url';

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'AretiaGameBuild/1.0 (city photo credits; contact via the project repository)';

export interface Photo {
  title: string;
  url: string;
  thumb: string;
  width: number;
  height: number;
  license: string;
  author: string;
  page: string;
}

/** True for a licence we may show with credit: CC BY, CC BY-SA, CC0, public domain. */
export function licenceAllowed(short: string): boolean {
  const l = short.trim().toLowerCase();
  if (!l || /\b(nc|nd)\b|non-?commercial|no-?deriv/.test(l)) return false;
  return /^cc[ -]by(-sa)?[ -]\d(\.\d)?(\s|$|[ -])/.test(l) || /^cc[ -]by(-sa)?$/.test(l) || l === 'cc0' || /^cc0\b/.test(l) || /public domain|^pd\b|^pdm/.test(l);
}

const strip = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

export function readPage(page: Record<string, unknown>): Photo | null {
  const info = (page.imageinfo as Record<string, unknown>[] | undefined)?.[0];
  if (!info) return null;
  const meta = (info.extmetadata ?? {}) as Record<string, { value?: string }>;
  const license = strip(meta.LicenseShortName?.value ?? '');
  const author = strip(meta.Artist?.value ?? '');
  const mime = String(info.mime ?? '');
  if (!licenceAllowed(license) || !author || !/^image\/(jpeg|png|webp)$/.test(mime)) return null;
  return { title: String(page.title), url: String(info.url), thumb: String(info.thumburl), width: Number(info.width), height: Number(info.height), license, author, page: String(info.descriptionurl) };
}

export async function search(query: string, limit = 12): Promise<Photo[]> {
  const q = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: String(limit), prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '900', iiextmetadatafilter: 'LicenseShortName|Artist' });
  // Commons asks callers to go gently: wait and try again if it says there have been too many requests.
  let body: { query?: { pages?: Record<string, Record<string, unknown>> } } = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    const res = await fetch(`${API}?${q.toString()}`, { headers: { 'user-agent': UA } });
    const text = await res.text();
    try {
      body = JSON.parse(text) as typeof body;
      break;
    } catch {
      if (attempt === 3) throw new Error('Wikimedia Commons did not answer: ' + text.slice(0, 80));
    }
  }
  return Object.values(body.query?.pages ?? {}).map(readPage).filter((p): p is Photo => p !== null && p.width >= 1400 && p.width > p.height * 1.2);
}

const q = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/** SQL that sets a city's photograph and its credit. The credit names the author, the licence and where it came from. */
export function photoSql(cityId: string, p: Photo): string {
  const credit = `Photo: ${p.author}, ${p.license}, via Wikimedia Commons`;
  return `update game_cities set image_url = ${q(p.thumb.replace(/\?.*$/, ''))}, image_credit = ${q(credit.slice(0, 300))} where id = ${q(cityId)};`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'search' && a) {
    for (const p of await search(a)) console.log(`${p.title}\n  ${p.width}x${p.height}  ${p.license}  by ${p.author.slice(0, 60)}\n  ${p.thumb.replace(/\?.*$/, '')}\n`);
  } else if (cmd === 'sql' && a && b) {
    const found = (await search(b.replace(/^File:/, ''), 3)).find((p) => p.title === b);
    if (!found) throw new Error('That file was not found with an allowed licence.');
    console.log(photoSql(a, found));
  } else console.error('Usage: search "<words>" | sql <city-id> "File:<name>"');
}
