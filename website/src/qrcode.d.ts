// The `qrcode` package ships no types; this is the part of it the Receive page uses.
declare module 'qrcode' {
  interface QrOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    color?: { dark?: string; light?: string };
  }
  export function toCanvas(canvas: HTMLCanvasElement, text: string, options?: QrOptions): Promise<void>;
  const qrcode: { toCanvas: typeof toCanvas };
  export default qrcode;
}
