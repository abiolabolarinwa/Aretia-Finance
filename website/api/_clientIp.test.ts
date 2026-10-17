import { describe, expect, it } from 'vitest';
import { clientIp } from './_clientIp';

describe('clientIp', () => {
  it('trusts the address the platform set, not what the caller put first in x-forwarded-for', () => {
    expect(clientIp({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 203.0.113.7' })).toBe('203.0.113.7');
  });
  it('falls back to x-real-ip', () => {
    expect(clientIp({ 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '9.9.9.9' })).toBe('198.51.100.2');
  });
  it('takes the last x-forwarded-for entry, which a caller cannot choose, so a made-up first entry changes nothing', () => {
    const a = clientIp({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' });
    const b = clientIp({ 'x-forwarded-for': '8.8.8.8, 203.0.113.7' });
    expect(a).toBe('203.0.113.7');
    expect(b).toBe(a);
  });
  it('reads array headers and says unknown when there is nothing', () => {
    expect(clientIp({ 'x-vercel-forwarded-for': ['203.0.113.9'] })).toBe('203.0.113.9');
    expect(clientIp({})).toBe('unknown');
  });
});
