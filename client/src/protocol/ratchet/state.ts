/**
 * ============================================================================
 *  VEIL — DOUBLE RATCHET STATE & TYPES
 * ============================================================================
 */

import type { RetentionMode } from '../../types/models';

export const MAX_SKIPPED_KEYS = 500;
export const MAX_CHAIN_SKIP = 200;

export interface SkippedKeyEntry {
  remoteDhPkHex: string;
  counter: number;
  messageKey: Uint8Array;
  createdAt: number;
}

export interface DoubleRatchetState {
  /** Root key (32 bytes) */
  rootKey: Uint8Array;
  /** Current sending chain key (32 bytes), null until first send or DH step */
  sendChainKey: Uint8Array | null;
  /** Current receiving chain key (32 bytes), null until first receive or DH step */
  recvChainKey: Uint8Array | null;
  /** Local ephemeral DH keypair */
  localDhSk: Uint8Array;
  localDhPk: Uint8Array;
  /** Remote party's current DH public key */
  remoteDhPk: Uint8Array | null;
  /** Sending message counter in current chain */
  sendCounter: number;
  /** Receiving message counter in current chain */
  recvCounter: number;
  /** Number of messages sent in previous sending chain */
  prevChainLen: number;
  /** Skipped message keys cache for out-of-order messages */
  skippedKeys: Map<string, SkippedKeyEntry>;
}

export interface RatchetEncryptedPayload {
  header: {
    dhPk: string; // base64url 32-byte DH public key
    pn: number;
    n: number;
    retention: RetentionMode;
    ttlMs?: number;
    msgId: string;
    senderFp?: string;
    recipientFp?: string;
  };
  nonce: Uint8Array; // 24-byte random nonce
  ciphertext: Uint8Array; // ciphertext + 16-byte Poly1305 tag
}

import { wipe } from '../../crypto/keys';

/**
 * Creates an independent clone of the ratchet state for tentative processing.
 */
export function cloneRatchetState(s: DoubleRatchetState): DoubleRatchetState {
  const skippedCopy = new Map<string, SkippedKeyEntry>();
  for (const [k, v] of s.skippedKeys) {
    skippedCopy.set(k, {
      remoteDhPkHex: v.remoteDhPkHex,
      counter: v.counter,
      messageKey: new Uint8Array(v.messageKey),
      createdAt: v.createdAt,
    });
  }
  return {
    rootKey: new Uint8Array(s.rootKey),
    sendChainKey: s.sendChainKey ? new Uint8Array(s.sendChainKey) : null,
    recvChainKey: s.recvChainKey ? new Uint8Array(s.recvChainKey) : null,
    localDhSk: new Uint8Array(s.localDhSk),
    localDhPk: new Uint8Array(s.localDhPk),
    remoteDhPk: s.remoteDhPk ? new Uint8Array(s.remoteDhPk) : null,
    sendCounter: s.sendCounter,
    recvCounter: s.recvCounter,
    prevChainLen: s.prevChainLen,
    skippedKeys: skippedCopy,
  };
}

/**
 * Commits tentative state to the live ratchet session only after successful authentication.
 */
export function commitRatchetState(target: DoubleRatchetState, source: DoubleRatchetState): void {
  wipe(target.rootKey);
  if (target.sendChainKey) wipe(target.sendChainKey);
  if (target.recvChainKey) wipe(target.recvChainKey);
  wipe(target.localDhSk);

  target.rootKey = source.rootKey;
  target.sendChainKey = source.sendChainKey;
  target.recvChainKey = source.recvChainKey;
  target.localDhSk = source.localDhSk;
  target.localDhPk = source.localDhPk;
  target.remoteDhPk = source.remoteDhPk;
  target.sendCounter = source.sendCounter;
  target.recvCounter = source.recvCounter;
  target.prevChainLen = source.prevChainLen;
  target.skippedKeys = source.skippedKeys;
}
