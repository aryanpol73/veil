/**
 * ============================================================================
 *  VEIL — RATCHET MANAGER
 * ============================================================================
 *  Manages the lifecycle and persistence of active Double Ratchet sessions
 *  across conversations.
 *
 *  Persistence failures propagate to the caller. A ratchet that advanced in
 *  memory but not on disk would desynchronise on the next unlock, so callers
 *  run decrypt + message insert in one transaction and call `purge(threadId)`
 *  if that transaction fails, forcing a reload of the last committed state.
 * ============================================================================
 */

import type { Contact, RetentionMode } from '../types/models';
import { wipe, type MaskIdentity } from '../crypto/keys';
import { loadRatchet, saveRatchet } from '../storage/db';
import {
  initAliceSession,
  initBobSession,
  ratchetEncryptMessage,
  ratchetDecryptMessage,
  toStoredRatchet,
  fromStoredRatchet,
  type DoubleRatchetState,
  type RatchetEncryptedPayload,
} from '../protocol/ratchet';

function wipeState(state: DoubleRatchetState): void {
  wipe(state.rootKey, state.sendChainKey, state.recvChainKey, state.localDhSk);
  for (const entry of state.skippedKeys.values()) wipe(entry.messageKey);
  state.skippedKeys.clear();
}

export class RatchetManager {
  private activeRatchets = new Map<string, DoubleRatchetState>();

  /**
   * Retrieves or loads the active ratchet state for a conversation thread.
   */
  public getOrLoadRatchet(threadId: string): DoubleRatchetState | null {
    let state = this.activeRatchets.get(threadId);
    if (state) return state;

    const stored = loadRatchet(threadId);
    if (!stored) return null;

    state = fromStoredRatchet(stored);
    this.activeRatchets.set(threadId, state);
    return state;
  }

  /**
   * Initializes a new outgoing ratchet session to a contact (Alice role).
   */
  public initOutgoingSession(threadId: string, contact: Contact): DoubleRatchetState {
    const state = initAliceSession(contact.dhPk);
    this.activeRatchets.set(threadId, state);
    this.persistRatchet(threadId, state);
    return state;
  }

  /** Returns the thread's session, creating an outgoing (Alice) one if needed. */
  public ensureOutgoingSession(threadId: string, contact: Contact): DoubleRatchetState {
    return this.getOrLoadRatchet(threadId) ?? this.initOutgoingSession(threadId, contact);
  }

  /** True once this side has decrypted at least one message in the session. */
  public hasReceived(threadId: string): boolean {
    const state = this.getOrLoadRatchet(threadId);
    return !!state && (state.recvChainKey !== null || state.recvCounter > 0);
  }

  /** Caches and persists a session that was established outside the manager. */
  public adoptSession(threadId: string, state: DoubleRatchetState): void {
    this.purge(threadId);
    this.activeRatchets.set(threadId, state);
    this.persistRatchet(threadId, state);
  }

  /**
   * Initializes an incoming ratchet session from an initial message (Bob role).
   */
  public initIncomingSession(
    threadId: string,
    mask: MaskIdentity,
    remoteDhPk: Uint8Array,
  ): DoubleRatchetState {
    const state = initBobSession(mask.dhSk, mask.dhPk, remoteDhPk);
    this.activeRatchets.set(threadId, state);
    return state;
  }

  /**
   * Encrypts a message using the thread's ratchet and persists updated state.
   */
  public encrypt(
    threadId: string,
    plaintext: Uint8Array,
    retention: RetentionMode,
    senderFp: string,
    msgId: string,
    contact: Contact,
    ttlMs?: number,
    aadContext?: string,
  ): RatchetEncryptedPayload {
    let state = this.getOrLoadRatchet(threadId);
    if (!state) {
      state = this.initOutgoingSession(threadId, contact);
    }

    const payload = ratchetEncryptMessage({
      state,
      plaintext,
      threadId: aadContext ?? threadId,
      retention,
      senderFp,
      msgId,
      ttlMs,
      recipientFp: contact.fingerprint,
    });

    this.persistRatchet(threadId, state);
    return payload;
  }

  /**
   * Decrypts an inbound message and advances the ratchet.
   *
   * `allowNewSession` must only be true for a thread that was created for
   * this very message. Starting an incoming session on an existing contact's
   * thread would let anyone who knows our exchange key post into that thread
   * under a forged sender fingerprint (audit A-03).
   */
  public decrypt(
    threadId: string,
    payload: RatchetEncryptedPayload,
    senderFp: string,
    mask: MaskIdentity,
    remoteDhPk: Uint8Array,
    aadContext?: string,
    allowNewSession = true,
  ): Uint8Array | null {
    let state = this.getOrLoadRatchet(threadId);
    if (!state) {
      if (!allowNewSession) return null;
      state = this.initIncomingSession(threadId, mask, remoteDhPk);
    }

    const plaintext = ratchetDecryptMessage({
      state,
      payload,
      threadId: aadContext ?? threadId,
      senderFp,
    });

    if (!plaintext) {
      // A freshly created incoming session that failed to authenticate must
      // not linger in the cache.
      if (!loadRatchet(threadId)) this.purge(threadId);
      return null;
    }
    this.persistRatchet(threadId, state);
    return plaintext;
  }

  public persistRatchet(threadId: string, state: DoubleRatchetState): void {
    saveRatchet(threadId, toStoredRatchet(state));
  }

  /** Drops cached state (and wipes its key material) for one thread or all. */
  public purge(threadId?: string): void {
    if (threadId) {
      const state = this.activeRatchets.get(threadId);
      if (state) wipeState(state);
      this.activeRatchets.delete(threadId);
      return;
    }
    for (const state of this.activeRatchets.values()) wipeState(state);
    this.activeRatchets.clear();
  }
}

export const ratchetManager = new RatchetManager();
export default ratchetManager;
