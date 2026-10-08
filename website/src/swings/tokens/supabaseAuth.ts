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
