/** A per-key failure counter that resets after its window. */
export interface AttemptLimiter {
  /** True once the key has used every attempt in the current window. */
  isLimited(key: string): boolean;
  /** Count one wrong attempt for the key. */
  recordFailure(key: string): void;
  /** Forget the key's failures, for example after it finally got the answer right. */
  clear(key: string): void;
  /** Forget every key, when the feature that owns the limiter shuts down. */
  clearAll(): void;
}

interface AttemptLimiterOptions {
  /** Wrong attempts allowed in one window. */
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Upper bound on tracked keys, so hostile traffic cannot grow the map forever. */
  maxKeys?: number;
}

interface FailureWindow {
  count: number;
  resetAt: number;
}

/** Build one limiter; callers keep separate limiters when the limits are independent. */
export function createAttemptLimiter({
  limit,
  windowMs,
  now = Date.now,
  maxKeys = 5_000,
}: AttemptLimiterOptions): AttemptLimiter {
  const windows = new Map<string, FailureWindow>();

  function prune(at: number): void {
    if (windows.size < maxKeys) return;
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
  }

  return {
    isLimited(key) {
      const at = now();
      const window = windows.get(key);
      if (window === undefined) return false;
      if (window.resetAt <= at) {
        windows.delete(key);
        return false;
      }
      return window.count >= limit;
    },
    recordFailure(key) {
      const at = now();
      prune(at);
      const window = windows.get(key);
      if (window === undefined || window.resetAt <= at) {
        windows.set(key, { count: 1, resetAt: at + windowMs });
        return;
      }
      window.count += 1;
    },
    clear(key) {
      windows.delete(key);
    },
    clearAll() {
      windows.clear();
    },
  };
}
