/**
 * ============================================================================
 *  VEIL — PAIR SECRETS, INBOX ADDRESSING & HEADER KEYS (wire v2)
 * ============================================================================
 *  Replaces the v1 scheme, in which every inbox was keyed by the recipient's
 *  STATIC exchange key and subscriptions were signed with the IDENTITY key.
 *  That let the relay link all of a user's traffic to one key, and let anyone
 *  holding an invite compute and squat the user's inboxes (audit A-01, A-09).
 *
 *  Two kinds of inbox exist:
 *
 *  1. Rendezvous inbox (first contact). Defined by the invite's random `rz`.
 *       inbox  = B64U(BLAKE2b(key = rz, "veil.rz.inbox.v2"))
 *       header = BLAKE2b(key = rz, "veil.rz.header.v2")
 *     The inviter claims it with an Ed25519 key from a private `authSeed`
 *     that never leaves the inviter's vault, so invite holders can send to it
 *     but cannot claim it.
 *
 *  2. Pair inbox (established session). Both sides hold a pair secret P,
 *     derived from the session's initial root key:
 *       P               = BLAKE2b(key = initialRoot, "veil.pair.v2")
 *       inbox(to X, e)  = B64U(BLAKE2b(key = P, "veil.pair.inbox.v2|" hex(X.ik) "|" e))
 *       header(to X)    = BLAKE2b(key = P, "veil.pair.header.v2|" hex(X.ik))
 *       authKey(inbox)  = Ed25519.keygen(BLAKE2b(key = P, "veil.pair.auth.v2|" inbox))
 *     The relay sees a fresh-looking inbox and key per contact, per direction,
 *     per epoch, none of which link to an identity or to each other.
 *
 *  KNOWN LIMITS: header keys are static per direction, so a later compromise
 *  of P exposes past headers (not bodies, which stay ratchet-protected). The
 *  relay sees how many inboxes a connection subscribes to.
 * ============================================================================
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { deriveSubSeed, rendezvousInboxId, toB64, toHex } from '../crypto/keys';

export { rendezvousInboxId };

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);

/** Pair inbox epoch. Longer than v1's hour to keep the subscription count low. */
export const PAIR_EPOCH_MS = 6 * 3_600_000;

/** Past pair epochs re-subscribed on connect; covers the relay's 24 h buffer. */
export const PAIR_CATCHUP_EPOCHS = 4;

export const pairEpoch = (nowMs: number = Date.now()): number => Math.floor(nowMs / PAIR_EPOCH_MS);

export interface InboxSigner {
  signPk: Uint8Array;
  signSk: Uint8Array;
}

const signerFromSeed = (seed: Uint8Array): InboxSigner => {
  const kp = ed25519.keygen(seed);
  return { signPk: kp.publicKey, signSk: new Uint8Array(kp.secretKey) };
};

const keyed = (key: Uint8Array, label: string, dkLen = 32): Uint8Array =>
  blake2b(utf8(label), { key, dkLen });

/* ------------------------------ Pair secret ------------------------------ */

/** Must be called on the session's INITIAL root key, before any DH step. */
export const pairSecretFromRoot = (initialRoot: Uint8Array): Uint8Array =>
  deriveSubSeed(initialRoot, 'veil.pair.v2');

/** Key that seals the initiator's intro; only the recipient can derive it. */
export const introKeyFromRoot = (initialRoot: Uint8Array): Uint8Array =>
  deriveSubSeed(initialRoot, 'veil.intro.key.v2');

export function pairInboxId(
  pairSecret: Uint8Array,
  recipientSignPk: Uint8Array,
  epoch: number = pairEpoch(),
): string {
  return toB64(keyed(pairSecret, `veil.pair.inbox.v2|${toHex(recipientSignPk)}|${epoch}`));
}

export const pairHeaderKey = (pairSecret: Uint8Array, recipientSignPk: Uint8Array): Uint8Array =>
  keyed(pairSecret, `veil.pair.header.v2|${toHex(recipientSignPk)}`);

export const pairInboxSigner = (pairSecret: Uint8Array, inbox: string): InboxSigner =>
  signerFromSeed(keyed(pairSecret, `veil.pair.auth.v2|${inbox}`));

/** Inboxes to subscribe to for mail addressed to `recipientSignPk`. */
export function pairInboxWindow(
  pairSecret: Uint8Array,
  recipientSignPk: Uint8Array,
  now: number = Date.now(),
): string[] {
  const e = pairEpoch(now);
  const out: string[] = [];
  for (let i = e - PAIR_CATCHUP_EPOCHS; i <= e + 1; i++) {
    out.push(pairInboxId(pairSecret, recipientSignPk, i));
  }
  return out;
}

/* ------------------------------- Rendezvous ------------------------------ */

export const rendezvousHeaderKey = (rz: Uint8Array): Uint8Array => keyed(rz, 'veil.rz.header.v2');

/** The inviter's private claim key for its rendezvous inbox. */
export const rendezvousSigner = (authSeed: Uint8Array): InboxSigner =>
  signerFromSeed(keyed(authSeed, 'veil.rz.auth.v2'));
