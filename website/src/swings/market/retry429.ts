/**
 * GeckoTerminal's public service allows about 30 requests a minute to the site as a whole, and answers 429 when that is spent.
 * A short wait usually clears it, so a request that was refused for that reason is asked again, a couple of times, waiting as
 * long as the service says (at most a few seconds) before each try.
 */
export const RETRY_MAX = 2;
export const RETRY_WAIT_MAX_MS = 5_000;
const RETRY_WAIT_DEFAULT_MS = 2_500;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `fetch`, asked again after a 429. Any other answer, good or bad, comes straight back. */
export async function fetchRetrying429(fetchImpl: typeof fetch, url: string, init?: RequestInit, sleep: (ms: number) => Promise<void> = realSleep, opts: { retries?: number; maxWaitMs?: number } = {}): Promise<Response> {
  const retries = opts.retries ?? RETRY_MAX;
  const maxWait = opts.maxWaitMs ?? RETRY_WAIT_MAX_MS;
  let res = await fetchImpl(url, init);
  for (let i = 0; i < retries && res.status === 429; i++) {
    const told = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(told) && told > 0 ? Math.min(told * 1000, maxWait) : Math.min(RETRY_WAIT_DEFAULT_MS, maxWait));
    res = await fetchImpl(url, init);
  }
  return res;
}
