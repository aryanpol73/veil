/**
 * ============================================================================
 *  VEIL — RECONNECT POLICY
 * ============================================================================
 *  Exponential backoff with full jitter to prevent thundering herd reconnection
 *  against the blind relay.
 * ============================================================================
 */

export interface ReconnectConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  jitter: boolean;
}

const DEFAULT_CONFIG: ReconnectConfig = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 1.5,
  jitter: true,
};

export class ReconnectPolicy {
  private config: ReconnectConfig;
  private attempts = 0;

  constructor(config: Partial<ReconnectConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public nextDelay(): number {
    const { initialDelayMs, maxDelayMs, factor, jitter } = this.config;
    const exp = Math.min(maxDelayMs, initialDelayMs * Math.pow(factor, this.attempts));
    this.attempts += 1;

    if (jitter) {
      // Full jitter: uniformly distributed between 0 and exp
      return Math.floor(Math.random() * exp);
    }
    return Math.floor(exp);
  }

  public reset(): void {
    this.attempts = 0;
  }

  public get attemptCount(): number {
    return this.attempts;
  }
}

export default ReconnectPolicy;
