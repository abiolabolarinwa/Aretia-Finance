import { describe, expect, it } from 'vitest';
import { isOriginAllowed, requestOrigin } from './_rpcProxy.js';
import { handleStatus } from './_swingsStatus.js';

describe('requestOrigin', () => {
  it('uses the Origin header when there is one', () => {
    expect(requestOrigin({ origin: 'https://aretiafinance.org' })).toBe('https://aretiafinance.org');
  });

  it('lets the page ask its own server: no Origin on a plain same-site GET, so the browser\'s same-origin marker and the Referer stand in', () => {
    expect(requestOrigin({ 'sec-fetch-site': 'same-origin', referer: 'https://aretiafinance.org/wallet#/swings' })).toBe('https://aretiafinance.org');
  });

  it('does not trust a Referer without the same-origin marker, from another site, or with a broken value', () => {
    expect(requestOrigin({ referer: 'https://aretiafinance.org/wallet' })).toBeNull();
    expect(requestOrigin({ 'sec-fetch-site': 'cross-site', referer: 'https://aretiafinance.org/wallet' })).toBeNull();
    expect(requestOrigin({ 'sec-fetch-site': 'same-origin' })).toBeNull();
    expect(requestOrigin({ 'sec-fetch-site': 'same-origin', referer: 'not a url' })).toBeNull();
    expect(requestOrigin({})).toBeNull();
  });

  it('still refuses another site even when it sends the same-origin marker with its own referer', () => {
    const origin = requestOrigin({ 'sec-fetch-site': 'same-origin', referer: 'https://evil.example/x' });
    expect(isOriginAllowed(origin, {})).toBe(false);
  });

  it('the status endpoint now answers the page\'s own plain GET, and still refuses a request with no origin at all', () => {
    const own = handleStatus({ method: 'GET', origin: requestOrigin({ 'sec-fetch-site': 'same-origin', referer: 'https://aretiafinance.org/wallet' }), env: {} });
    expect(own.status).toBe(200);
    expect(JSON.parse(own.body).evm.chains).toContain('base');
    expect(handleStatus({ method: 'GET', origin: requestOrigin({}), env: {} }).status).toBe(403);
  });
});
