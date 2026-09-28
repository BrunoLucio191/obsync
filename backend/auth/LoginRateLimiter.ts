import { type Request } from "express";
const DEFAULT_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_BLOCK_DURATION_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
const DEFAULT_MAX_TRACKED_KEYS = 10_000;

type AttemptRecord = {
  failures: number[];
  blockedUntil: number;
};

export type LoginRateLimit = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type LoginRateLimiterOptions = {
  attemptWindowMs?: number;
  blockDurationMs?: number;
  maxFailedAttempts?: number;
  /** Bounds memory. */
  maxTrackedKeys?: number;
};

/** Sliding window per key (account or IP), kept only in memory. */
export class LoginRateLimiter {
  readonly #attempts = new Map<string, AttemptRecord>();
  readonly #attemptWindowMs: number;
  readonly #blockDurationMs: number;
  readonly #maxFailedAttempts: number;
  readonly #maxTrackedKeys: number;

  public constructor(options: LoginRateLimiterOptions = {}) {
    this.#attemptWindowMs = options.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS;
    this.#blockDurationMs = options.blockDurationMs ?? DEFAULT_BLOCK_DURATION_MS;
    this.#maxFailedAttempts = options.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
    this.#maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
  }

  public check(key: string): LoginRateLimit {
    const now = Date.now();
    this.#removeExpiredRecords(now);
    const record = this.#attempts.get(key);
    if (!record) return { allowed: true, retryAfterSeconds: 0 };

    this.#removeOldFailures(record, now);
    if (record.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((record.blockedUntil - now) / 1_000),
      };
    }

    if (record.failures.length === 0) this.#attempts.delete(key);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  public recordFailure(key: string): LoginRateLimit {
    const now = Date.now();
    this.#removeExpiredRecords(now);
    if (!this.#attempts.has(key) && this.#attempts.size >= this.#maxTrackedKeys) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(this.#blockDurationMs / 1_000),
      };
    }

    const record = this.#attempts.get(key) ?? {
      failures: [],
      blockedUntil: 0,
    };
    this.#removeOldFailures(record, now);
    record.failures.push(now);

    if (record.failures.length >= this.#maxFailedAttempts) {
      record.blockedUntil = now + this.#blockDurationMs;
    }

    this.#attempts.set(key, record);
    return this.check(key);
  }

  /** Call after a successful login. */
  public reset(key: string): void {
    this.#attempts.delete(key);
  }

  #removeOldFailures(record: AttemptRecord, now: number): void {
    const threshold = now - this.#attemptWindowMs;
    record.failures = record.failures.filter((attempt) => attempt > threshold);
    if (record.blockedUntil <= now) record.blockedUntil = 0;
  }

  #removeExpiredRecords(now: number): void {
    for (const [key, record] of this.#attempts) {
      this.#removeOldFailures(record, now);
      if (record.failures.length === 0 && record.blockedUntil === 0) {
        this.#attempts.delete(key);
      }
    }
  }

  static loginRateLimitKeys = (
    req: Request,
    email: string,
  ): { accountKey: string; ipKey: string } => {
    const normalizedEmail = email.normalize("NFKC").trim().toLowerCase();
    const address = req.ip ?? req.socket.remoteAddress ?? "unknown";
    return {
      accountKey: `account:${normalizedEmail}`,
      ipKey: `ip:${address}`,
    };
  };
}
