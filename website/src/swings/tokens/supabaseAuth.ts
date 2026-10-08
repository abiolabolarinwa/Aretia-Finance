/**
 * Headers for Supabase's REST interface with the service key.
 *
 * Supabase has two kinds of keys. The older "service_role" key is a JWT (it starts with "eyJ") and is sent both as the
 * apikey and as a Bearer token. The newer "secret" keys (they start with "sb_secret_") are NOT JWTs: they go in the
 * apikey header only, and sending one as a Bearer token is refused. Projects made recently get the newer kind by default.
 */
export function supabaseHeaders(key: string): Record<string, string> {
  return key.startsWith('eyJ') ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key };
}

/**
 * The project address, tidied: quotes and spaces removed, `https://` added if it was left off, and any trailing slash or
 * `/rest/v1` removed (the code adds that itself). Only the host is kept, so a pasted dashboard link or a path cannot
 * send requests anywhere else. Returns null if nothing usable is left.
 */
export function supabaseBase(value: string | undefined): string | null {
  const raw = (value ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === 'https:' && u.hostname.includes('.') ? `https://${u.host}` : null;
  } catch {
    return null;
  }
}
