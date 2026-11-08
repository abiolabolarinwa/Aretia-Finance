import { describe, expect, it } from 'vitest';
import { isNativeApp, nativePlatform } from './nativeApp';

describe('nativePlatform', () => {
  it('is null on the website, where there is no Capacitor object', () => {
    expect(nativePlatform({})).toBeNull();
    expect(isNativeApp({})).toBe(false);
  });
  it('is null when Capacitor says it is a plain web page', () => {
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } })).toBeNull();
  });
  it('names the platform inside the app', () => {
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } })).toBe('android');
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } })).toBe('ios');
  });
  it('treats an unknown platform or a throwing bridge as not the app', () => {
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'electron' } })).toBeNull();
    expect(nativePlatform({ Capacitor: { isNativePlatform: () => { throw new Error('x'); } } })).toBeNull();
  });
});
