/**
 * The address a request really came from, for rate limits.
 *
 * A caller can send any `x-forwarded-for` it likes, so taking the first entry lets one client pick a new identity on every request and
 * walk around the limit. On Vercel the platform sets `x-vercel-forwarded-for` and `x-real-ip` itself and overwrites whatever the caller sent,
 * so those come first. If neither is there (a local run, another host), the last `x-forwarded-for` entry is used, which is the one the
 * nearest proxy added and the caller cannot write.
 */
type Header = string | string[] | undefined;

const one = (v: Header): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export function clientIp(headers: Record<string, Header>): string {
  const platform = one(headers['x-vercel-forwarded-for'])?.split(',')[0]?.trim();
  if (platform) return platform;
  const real = one(headers['x-real-ip'])?.trim();
  if (real) return real;
  const parts = (one(headers['x-forwarded-for']) ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}
