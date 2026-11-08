/**
 * Is this page running inside the Aretia Android or iPhone app? Anything that only makes sense in the app (phone wallet
 * connection, push, device unlock) asks here first, so the website, the browser extension and phone browsers keep behaving
 * exactly as they do today. Capacitor puts a `Capacitor` object on the window only inside the native shell.
 */
export interface CapacitorLike {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

export type NativePlatform = 'android' | 'ios';

export function nativePlatform(win: { Capacitor?: CapacitorLike } | undefined = typeof window === 'undefined' ? undefined : (window as unknown as { Capacitor?: CapacitorLike })): NativePlatform | null {
  const cap = win?.Capacitor;
  try {
    if (!cap || cap.isNativePlatform?.() !== true) return null;
    const p = cap.getPlatform?.();
    return p === 'android' || p === 'ios' ? p : null;
  } catch {
    return null;
  }
}

export const isNativeApp = (win?: { Capacitor?: CapacitorLike }): boolean => nativePlatform(win) !== null;
