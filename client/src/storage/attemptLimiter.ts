/**
 * ============================================================================
 *  VEIL — PIN ATTEMPT LIMITER (audit A-12)
 * ============================================================================
 *  Escalating delays after repeated wrong PINs. Design constraints:
 *
 *   - ONE counter for the whole device, kept in the OS keystore, outside both
 *     vaults. A counter inside a vault would reveal that vault exists, and a
 *     per-vault counter would behave differently depending on which PIN the
 *     user usually enters.
 *   - Every attempt writes the counter, success or failure, so the keystore
 *     I/O pattern does not reveal the outcome.
 *   - It only delays. It never wipes: a wipe-on-N-failures policy hands any
 *     coercer a way to destroy evidence, and that choice belongs to the user
 *     (a later, opt-in panic-wipe feature).
 *
 *  HONEST LIMITS: this slows guessing through the app's own UI. It does not
 *  stop an attacker who can reset the keystore entry, move the device clock,
 *  or run Argon2id offline (which still needs the keystore-held device salt).
 * ============================================================================
 */

import { Keychain } from './keychain';

const LIMITER_KEY = 'veil.unlock.limiter.v1';

/** Free attempts before any delay applies. */
export const FREE_ATTEMPTS = 4;

/** Delay after the Nth consecutive failure beyond the free attempts. */
const SCHEDULE_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface LimiterState {
  failures: number;
  /** Epoch ms before which no attempt is evaluated. */
  lockedUntil: number;
}

export const delayAfter = (failures: number): number => {
  if (failures <= FREE_ATTEMPTS) return 0;
  const i = Math.min(failures - FREE_ATTEMPTS - 1, SCHEDULE_MS.length - 1);
  return SCHEDULE_MS[i];
};

export async function readLimiter(): Promise<LimiterState> {
  const raw = await Keychain.getItem(LIMITER_KEY);
  if (!raw) return { failures: 0, lockedUntil: 0 };
  try {
    const parsed = JSON.parse(raw);
    const failures = Number.isInteger(parsed.failures) && parsed.failures >= 0 ? parsed.failures : 0;
    const lockedUntil = Number.isFinite(parsed.lockedUntil) ? parsed.lockedUntil : 0;
    return { failures, lockedUntil };
  } catch {
    // A corrupted entry must not unlock the delay schedule.
    return { failures: FREE_ATTEMPTS + 1, lockedUntil: Date.now() + SCHEDULE_MS[0] };
  }
}

/** Milliseconds until the next attempt may be evaluated (0 = now). */
export function retryAfter(state: LimiterState, now: number = Date.now()): number {
  return Math.max(0, state.lockedUntil - now);
}

/** Records an attempt's outcome. Always writes, whatever the outcome. */
export async function recordAttempt(
  state: LimiterState,
  success: boolean,
  now: number = Date.now(),
): Promise<LimiterState> {
  const next: LimiterState = success
    ? { failures: 0, lockedUntil: 0 }
    : { failures: state.failures + 1, lockedUntil: now + delayAfter(state.failures + 1) };
  await Keychain.setItem(LIMITER_KEY, JSON.stringify(next));
  return next;
}

/** Test seam. */
export async function resetLimiter(): Promise<void> {
  await Keychain.deleteItem(LIMITER_KEY);
}
