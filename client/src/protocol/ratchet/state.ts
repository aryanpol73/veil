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
  };
  nonce: Uint8Array; // 24-byte random nonce
  ciphertext: Uint8Array; // ciphertext + 16-byte Poly1305 tag
}
