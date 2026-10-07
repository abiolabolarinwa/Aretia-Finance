/**
 * Sends anonymous aggregate events to /api/swings-events, only when the server says analytics are on.
 * Events are the allow-listed fields (name, chain, provider id, status, duration, route count). Wallet
 * addresses, amounts and token identities are never part of an event. Batched and best-effort: a failed
 * send is dropped, never retried and never shown to the user.
 */
import type { LoggedEvent, TelemetrySink } from './telemetry.js';

const SEND = new Set(['quote_failed', 'routes_found', 'swap', 'shadow']);

/** Reduces a logged event to the fields the server accepts. Returns null for events that are not sent. */
export function toWire(entry: LoggedEvent): Record<string, unknown> | null {
  const e = entry.event;
  if (typeof e.name !== 'string' || !SEND.has(e.name)) return null;
  const wire: Record<string, unknown> = { name: e.name };
  for (const k of ['chain', 'provider', 'status', 'ms', 'count', 'rival', 'diff'] as const) if (e[k] !== undefined) wire[k] = e[k];
  if (e.name === 'routes_found' && typeof e.best === 'string') wire.provider = e.best;
  return wire;
}

export class BeaconSink implements TelemetrySink {
  private queue: Record<string, unknown>[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly enabled: () => boolean,
    private readonly send: (body: string) => void = (body) => {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) navigator.sendBeacon('/api/swings-events', new Blob([body], { type: 'text/plain' }));
    },
  ) {}

  write(entry: LoggedEvent): void {
    if (!this.enabled()) return;
    const wire = toWire(entry);
    if (!wire) return;
    this.queue.push(wire);
    if (this.queue.length >= 10) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 5_000);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0, 20);
    try {
      this.send(JSON.stringify({ events }));
    } catch {
      // Dropped on purpose.
    }
  }
}
