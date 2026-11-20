/** How long the server keeps an empty meeting for the same person to come back. */
export const REJOIN_GRACE_MS = 120_000;

/** The join details kept for this tab so a reload can restore the same seat and name. */
export interface StoredJoin {
  name: string;
  role: string;
  media: { microphone: boolean; camera: boolean };
  meetingCode?: string;
}

const PREFIX = 'kaki.join.';

function storageKey(variant: string): string {
  return `${PREFIX}${variant}`;
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function isStoredJoin(value: unknown): value is StoredJoin {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== 'string' || entry.name.trim() === '') return false;
  if (typeof entry.role !== 'string' || entry.role.trim() === '') return false;
  const media = entry.media;
  if (typeof media !== 'object' || media === null) return false;
  const choice = media as Record<string, unknown>;
  if (typeof choice.microphone !== 'boolean' || typeof choice.camera !== 'boolean') return false;
  return entry.meetingCode === undefined || typeof entry.meetingCode === 'string';
}

/** The join this tab used last, if it can still be read. */
export function readStoredJoin(variant: string): StoredJoin | undefined {
  const store = storage();
  if (store === undefined) return undefined;
  const raw = store.getItem(storageKey(variant));
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredJoin(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Remember the seat this tab joined with so a reload can return to it. */
export function storeJoin(variant: string, join: StoredJoin): void {
  const store = storage();
  if (store === undefined) {
    console.warn('kaki rejoin: this browser blocks session storage, so a reload cannot restore the seat');
    return;
  }
  try {
    store.setItem(storageKey(variant), JSON.stringify(join));
  } catch (error) {
    console.warn('kaki rejoin: could not remember this seat for a reload', error);
  }
}

export function clearStoredJoin(variant: string): void {
  try {
    storage()?.removeItem(storageKey(variant));
  } catch {
    // Storage being unavailable means there is nothing to clear.
  }
}

/** Forget every tab's remembered join, so "start a new meeting" never restores the old one. */
export function clearAllStoredJoins(): void {
  const store = storage();
  if (store === undefined) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Storage being unavailable means there is nothing to clear.
  }
}

/** A short clock for the empty-room hold, such as "1:47". */
export function formatGraceRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
