const DEFAULT_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_BLOCK_DURATION_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_MAX_TRACKED_KEYS = 10_000;

/** Per-key tracking state: timestamps of recent failures and, if blocked, until when. */
type AttemptRecord = {
  failures: number[];
  blockedUntil: number;
};

/** Result of checking or updating the rate limit state for a key. */
export type LoginRateLimit = {
  /** Whether the request should be allowed to proceed. */
  allowed: boolean;
  /** If `allowed` is `false`, how many seconds the caller should wait before retrying. */
  retryAfterSeconds: number;
};

/** Configuration overrides for {@link LoginRateLimiter}. All fields fall back to module defaults when omitted. */
type LoginRateLimiterOptions = {
  /** Sliding window (ms) over which failures are counted. */
  attemptWindowMs?: number;
  /** How long (ms) a key stays blocked once it exceeds `maxFailedAttempts`. */
  blockDurationMs?: number;
  /** Number of failures within `attemptWindowMs` that triggers a block. */
  maxFailedAttempts?: number;
  /** Maximum number of distinct keys tracked at once, to bound memory usage. */
  maxTrackedKeys?: number;
};

/**
 * In-memory sliding-window rate limiter used to throttle repeated failed login/password
 * attempts per key (e.g. per account or per IP). State is not persisted across restarts.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly attemptWindowMs: number;
  private readonly blockDurationMs: number;
  private readonly maxFailedAttempts: number;
  private readonly maxTrackedKeys: number;

  /**
   * @param options - Optional overrides for window size, block duration, failure threshold, and tracked-key cap.
   */
  public constructor(options: LoginRateLimiterOptions = {}) {
    this.attemptWindowMs =
      options.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS;
    this.blockDurationMs =
      options.blockDurationMs ?? DEFAULT_BLOCK_DURATION_MS;
    this.maxFailedAttempts =
      options.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
    this.maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  }

  /**
   * Checks whether a key is currently allowed to attempt a login, without recording a new attempt.
   * @param key - Identifier being rate-limited (e.g. `"account:<email>"` or `"ip:<address>"`).
   * @returns Whether the key is allowed, and if not, how long to wait.
   */
  public check(key: string): LoginRateLimit {
    const now = Date.now();
    this.removeExpiredRecords(now);
    const record = this.attempts.get(key);
    if (!record) return { allowed: true, retryAfterSeconds: 0 };

    this.removeOldFailures(record, now);
    if (record.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((record.blockedUntil - now) / 1_000),
      };
    }

    if (record.failures.length === 0) this.attempts.delete(key);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Records a failed attempt for a key, blocking it if the failure threshold is reached, then
   * returns the resulting limit state (equivalent to calling {@link check} afterward).
   * @param key - Identifier being rate-limited.
   * @returns Whether the key is still allowed after this failure, and if not, how long to wait.
   */
  public recordFailure(key: string): LoginRateLimit {
    const now = Date.now();
    this.removeExpiredRecords(now);
    if (!this.attempts.has(key) && this.attempts.size >= this.maxTrackedKeys) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(this.blockDurationMs / 1_000),
      };
    }

    const record = this.attempts.get(key) ?? {
      failures: [],
      blockedUntil: 0,
    };
    this.removeOldFailures(record, now);
    record.failures.push(now);

    if (record.failures.length >= this.maxFailedAttempts) {
      record.blockedUntil = now + this.blockDurationMs;
    }

    this.attempts.set(key, record);
    return this.check(key);
  }

  /**
   * Clears all tracked failures/blocks for a key, typically called after a successful login.
   * @param key - Identifier to reset.
   */
  public reset(key: string): void {
    this.attempts.delete(key);
  }

  /** Drops failures outside the sliding window from a record, and clears an expired block. */
  private removeOldFailures(record: AttemptRecord, now: number): void {
    const threshold = now - this.attemptWindowMs;
    record.failures = record.failures.filter((attempt) => attempt > threshold);
    if (record.blockedUntil <= now) record.blockedUntil = 0;
  }

  /** Sweeps the whole `attempts` map, dropping any key that no longer has failures or an active block. */
  private removeExpiredRecords(now: number): void {
    for (const [key, record] of this.attempts) {
      this.removeOldFailures(record, now);
      if (record.failures.length === 0 && record.blockedUntil === 0) {
        this.attempts.delete(key);
      }
    }
  }
}
