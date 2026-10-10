/**
 * The notifications a person has received on this device: what the bell lists and counts. Price alerts for favourites
 * land here as they are raised. Everything is browser-local: nothing is sent anywhere, and nothing arrives while the
 * page is closed.
 */
import type { StorageLike } from '../history.js';

const KEY = 'aretia-notifications-v1';
const SOUND_KEY = 'aretia-notify-sound-v1';
export const NOTIFICATION_MAX = 50;

export type NotificationTone = 'up' | 'down' | 'info';

export interface AppNotification {
  id: string;
  at: number;
  title: string;
  detail: string;
  tone: NotificationTone;
  icon: string | null;
  read: boolean;
}

export type NewNotification = Pick<AppNotification, 'title'> & Partial<Pick<AppNotification, 'detail' | 'tone' | 'icon' | 'at'>>;

const TONES: readonly string[] = ['up', 'down', 'info'];

function valid(n: unknown): n is AppNotification {
  if (!n || typeof n !== 'object') return false;
  const v = n as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.at === 'number' && Number.isFinite(v.at) && typeof v.title === 'string' && typeof v.detail === 'string' && typeof v.tone === 'string' && TONES.includes(v.tone) && typeof v.read === 'boolean' && (v.icon === null || typeof v.icon === 'string');
}

export class NotificationStore {
  private seq = 0;
  constructor(private readonly storage: StorageLike | null, private readonly now: () => number = Date.now) {}

  private read(): AppNotification[] {
    try {
      const raw = this.storage?.getItem(KEY);
      const v: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(v) ? v.filter(valid).slice(0, NOTIFICATION_MAX) : [];
    } catch {
      return [];
    }
  }

  private write(items: AppNotification[]): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(items.slice(0, NOTIFICATION_MAX)));
    } catch {
      // not remembered: the bell still works for this visit
    }
  }

  /** Newest first. */
  list(): AppNotification[] {
    return this.read();
  }

  unread(): number {
    return this.read().filter((n) => !n.read).length;
  }

  /** Adds one at the top, unread. The oldest drop off once there are more than NOTIFICATION_MAX. */
  add(n: NewNotification): AppNotification {
    const at = n.at ?? this.now();
    const item: AppNotification = {
      id: `${at.toString(36)}-${(this.seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at,
      title: n.title,
      detail: n.detail ?? '',
      tone: n.tone ?? 'info',
      icon: n.icon && /^https:\/\//.test(n.icon) ? n.icon : null,
      read: false,
    };
    this.write([item, ...this.read()]);
    return item;
  }

  markAllRead(): void {
    const items = this.read();
    if (items.some((n) => !n.read)) this.write(items.map((n) => ({ ...n, read: true })));
  }

  clear(): void {
    this.write([]);
  }

  /** Whether a ringing sound plays when a notification arrives. On unless the person turned it off. */
  soundOn(): boolean {
    try {
      return this.storage?.getItem(SOUND_KEY) !== 'off';
    } catch {
      return true;
    }
  }

  setSound(on: boolean): void {
    try {
      this.storage?.setItem(SOUND_KEY, on ? 'on' : 'off');
    } catch {
      // not remembered
    }
  }
}
