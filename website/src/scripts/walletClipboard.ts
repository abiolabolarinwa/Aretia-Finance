/**
 * Reading what was copied, for the Paste buttons (search, Pay). Inside the Android or iPhone app the web view usually refuses the
 * browser's clipboard, so the app's native Clipboard plugin is asked first; in a browser, the browser's own clipboard. Returns the text,
 * or '' when nothing could be read (the caller then asks the person to press and hold in the box and choose Paste).
 */
interface NativeClipboard {
  read(): Promise<{ value?: string; type?: string }>;
}

export async function readClipboard(): Promise<string> {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { Clipboard?: NativeClipboard } } }).Capacitor;
  try {
    if (cap?.isNativePlatform?.() && cap.Plugins?.Clipboard) {
      const r = await cap.Plugins.Clipboard.read();
      if (typeof r?.value === 'string' && r.value.trim()) return r.value.trim();
    }
  } catch {
    // Fall through to the browser's clipboard.
  }
  try {
    if (navigator.clipboard?.readText) return (await navigator.clipboard.readText()).trim();
  } catch {
    // Not allowed here.
  }
  return '';
}
