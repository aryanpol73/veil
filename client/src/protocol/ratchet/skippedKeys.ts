/**
 * ============================================================================
 *  VEIL — SKIPPED MESSAGE KEYS MANAGER
 * ============================================================================
 *  Handles out-of-order message key caching, replay rejection, and bounded
 *  storage. If a message arrives ahead of sequence, the intermediate keys
 *  are computed, stored here, and immediately deleted once consumed.
 * ============================================================================
 */

import { toHex, wipe } from '../../crypto/keys';
import { MAX_SKIPPED_KEYS, type DoubleRatchetState, type SkippedKeyEntry } from './state';

export function makeSkippedKeyId(remoteDhPkHex: string, counter: number): string {
  return `${remoteDhPkHex}:${counter}`;
}

/**
 * Stores a skipped message key for late delivery handling.
 * Enforces maximum capacity by evicting the oldest key if necessary.
 */
export function storeSkippedKey(
  state: DoubleRatchetState,
  remoteDhPk: Uint8Array,
  counter: number,
  messageKey: Uint8Array,
): void {
  const pkHex = toHex(remoteDhPk);
  const id = makeSkippedKeyId(pkHex, counter);

  // If at capacity, evict oldest entry to prevent memory exhaustion attacks
  if (state.skippedKeys.size >= MAX_SKIPPED_KEYS) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [keyId, entry] of state.skippedKeys) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt;
        oldestKey = keyId;
      }
    }
    if (oldestKey) {
      const doomed = state.skippedKeys.get(oldestKey);
      if (doomed) wipe(doomed.messageKey);
      state.skippedKeys.delete(oldestKey);
    }
  }

  state.skippedKeys.set(id, {
    remoteDhPkHex: pkHex,
    counter,
    messageKey: new Uint8Array(messageKey),
    createdAt: Date.now(),
  });
}

/**
 * Retrieves and permanently consumes a skipped message key.
 * Returns null if the key was not found or already consumed.
 */
export function consumeSkippedKey(
  state: DoubleRatchetState,
  remoteDhPk: Uint8Array,
  counter: number,
): Uint8Array | null {
  const pkHex = toHex(remoteDhPk);
  const id = makeSkippedKeyId(pkHex, counter);

  const entry = state.skippedKeys.get(id);
  if (!entry) return null;

  state.skippedKeys.delete(id);
  const key = new Uint8Array(entry.messageKey);
  wipe(entry.messageKey);
  return key;
}

export default {
  makeSkippedKeyId,
  storeSkippedKey,
  consumeSkippedKey,
};
