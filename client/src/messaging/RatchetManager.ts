/**
 * ============================================================================
 *  VEIL — RATCHET MANAGER
 * ============================================================================
 *  Manages the lifecycle and persistence of active Double Ratchet sessions
 *  across conversations.
 * ============================================================================
 */

import type { Contact, RetentionMode } from '../types/models';
import type { MaskIdentity } from '../crypto/keys';
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
    this.persistRatchet(threadId, state);
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
   */
  public decrypt(
    threadId: string,
    payload: RatchetEncryptedPayload,
    senderFp: string,
    mask: MaskIdentity,
    remoteDhPk: Uint8Array,
    aadContext?: string,
  ): Uint8Array | null {
    let state = this.getOrLoadRatchet(threadId);
    if (!state) {
      state = this.initIncomingSession(threadId, mask, remoteDhPk);
    }

    const plaintext = ratchetDecryptMessage({
      state,
      payload,
      threadId: aadContext ?? threadId,
      senderFp,
    });

    if (plaintext) {
      this.persistRatchet(threadId, state);
    }
    return plaintext;
  }

  public persistRatchet(threadId: string, state: DoubleRatchetState): void {
    try {
      saveRatchet(threadId, toStoredRatchet(state));
    } catch {
      /* ignore if vault locked */
    }
  }

  public purge(threadId?: string): void {
    if (threadId) {
      this.activeRatchets.delete(threadId);
    } else {
      this.activeRatchets.clear();
    }
  }
}

export const ratchetManager = new RatchetManager();
export default ratchetManager;
