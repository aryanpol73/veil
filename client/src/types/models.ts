/**
 * ============================================================================
 *  VEIL — DOMAIN MODELS & PROTOCOL TYPES
 * ============================================================================
 */

import type { RetentionMode } from '../theme/obsidianPrism';

export type { RetentionMode };

export type VerificationState = 'UNVERIFIED' | 'VERIFIED' | 'CHANGED_IDENTITY';

export interface Contact {
  id: string;
  maskIndex: number;
  alias: string;
  signPk: Uint8Array;
  dhPk: Uint8Array;
  fingerprint: string;
  verifiedAt: number | null;
  createdAt: number;
  verificationState: VerificationState;
}

export interface Thread {
  id: string;
  contactId: string;
  defaultRetention: RetentionMode;
  lastActivityAt: number;
  unreadCount: number;
  contact?: Contact;
  lastMessage?: StoredMessage;
}

export interface StoredMessage {
  id: string;
  thread_id: string;
  direction: 'in' | 'out';
  retention: RetentionMode;
  body: string;
  created_at: number;
  expires_at: number | null;
  ttl_ms: number | null;
  delivered_at: number | null;
  read_at: number | null;
  counter: number;
}

/* -------------------------------------------------------------------------- */
/* Double Ratchet Protocol Framing                                            */
/* -------------------------------------------------------------------------- */

export interface RatchetHeader {
  /** Ephemeral sender X25519 DH public key (32 bytes, base64url encoded) */
  dhPk: string;
  /** Previous sending chain message count */
  pn: number;
  /** Current sending chain message index/counter */
  n: number;
  /** Retention mode */
  retention: RetentionMode;
  /** Armed TTL for timed messages */
  ttlMs?: number;
  /** Unique message ID */
  msgId: string;
  /** Sender Crockford Base32 fingerprint */
  senderFp?: string;
  /** Recipient Crockford Base32 fingerprint */
  recipientFp?: string;
}

export interface WireEnvelope {
  v: 1;
  id: string;
  inbox: string;
  header: RatchetHeader;
  nonce: string; // 24-byte nonce base64url
  ciphertext: string; // AEAD ciphertext + 16-byte Poly1305 tag base64url
}

/* -------------------------------------------------------------------------- */
/* WebSocket Relay Frames                                                     */
/* -------------------------------------------------------------------------- */

export type ClientFrame =
  | { t: 'HELLO'; v: 1 }
  | { t: 'SUB'; inbox: string; pk: string; sig: string }
  | { t: 'UNSUB'; inbox: string }
  | { t: 'SEND'; inbox: string; env: string }
  | { t: 'ACK'; inbox: string; ids: string[] }
  | { t: 'NOOP' }
  | { t: 'PING' };

export type ServerFrame =
  | { t: 'HELLO'; v: 1; nonce: string; envelopeBytes: number }
  | { t: 'SUBBED'; inbox: string }
  | { t: 'DENIED'; inbox: string }
  | { t: 'DELIVER'; inbox: string; id: string; env: string }
  | { t: 'ACCEPTED'; inbox: string; id: string }
  | { t: 'DROPPED'; inbox: string; reason: 'full' }
  | { t: 'PONG' }
  | { t: 'ERR'; code: string };
