import { describe, expect, it } from 'vitest';
import { NOTIFICATION_MAX, NotificationStore } from './notifications.js';
import type { StorageLike } from '../history.js';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('NotificationStore', () => {
  it('lists newest first and counts what is unread', () => {
    const s = new NotificationStore(memory(), () => 1000);
    s.add({ title: 'first', at: 1 });
    s.add({ title: 'second', at: 2 });
    expect(s.list().map((n) => n.title)).toEqual(['second', 'first']);
    expect(s.unread()).toBe(2);
  });

  it('marks all read, then clears', () => {
    const s = new NotificationStore(memory());
    s.add({ title: 'a' });
    s.markAllRead();
    expect(s.unread()).toBe(0);
    expect(s.list()).toHaveLength(1);
    s.clear();
    expect(s.list()).toHaveLength(0);
  });

  it('keeps at most NOTIFICATION_MAX, dropping the oldest', () => {
    const s = new NotificationStore(memory());
    for (let i = 0; i < NOTIFICATION_MAX + 5; i++) s.add({ title: `n${i}`, at: i });
    const list = s.list();
    expect(list).toHaveLength(NOTIFICATION_MAX);
    expect(list[0].title).toBe(`n${NOTIFICATION_MAX + 4}`);
  });

  it('survives a reload and ignores a damaged or hostile store', () => {
    const m = memory();
    new NotificationStore(m).add({ title: 'kept', tone: 'up' });
    expect(new NotificationStore(m).list()[0]).toMatchObject({ title: 'kept', tone: 'up', read: false });
    m.setItem('aretia-notifications-v1', '{not json');
    expect(new NotificationStore(m).list()).toEqual([]);
    m.setItem('aretia-notifications-v1', JSON.stringify([{ id: 1 }, null, 'x', { id: 'a', at: 1, title: 't', detail: '', tone: 'evil', icon: null, read: false }]));
    expect(new NotificationStore(m).list()).toEqual([]);
  });

  it('only keeps an https picture', () => {
    const s = new NotificationStore(memory());
    expect(s.add({ title: 'a', icon: 'javascript:alert(1)' }).icon).toBeNull();
    expect(s.add({ title: 'b', icon: 'http://x/y.png' }).icon).toBeNull();
    expect(s.add({ title: 'c', icon: 'https://x/y.png' }).icon).toBe('https://x/y.png');
  });

  it('works with no storage at all', () => {
    const s = new NotificationStore(null);
    s.add({ title: 'a' });
    expect(s.list()).toEqual([]);
    expect(s.soundOn()).toBe(true);
  });

  it('has the sound on until it is turned off, and remembers the choice', () => {
    const m = memory();
    const s = new NotificationStore(m);
    expect(s.soundOn()).toBe(true);
    s.setSound(false);
    expect(new NotificationStore(m).soundOn()).toBe(false);
    s.setSound(true);
    expect(new NotificationStore(m).soundOn()).toBe(true);
  });
});
