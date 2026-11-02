/**
 * ============================================================================
 *  VEIL — INNER PAYLOAD & INITIATOR INTRODUCTION
 * ============================================================================
 *  Body plaintext (inside the ratchet AEAD; UTF-8 JSON):
 *    { "v": 1, "body": "<text>" }
 *
 *  Intro (initiator only, until it has received a reply). Sealed with
 *  XChaCha20-Poly1305 under a key derived from the session's INITIAL root key
 *  (pairing.introKeyFromRoot), AAD = "veil.intro.v2|" + header.dhPk, and
 *  carried in the sealed envelope next to the header. Only the recipient can
 *  derive that key, so other holders of the invite cannot read it. The
 *  recipient needs it BEFORE opening the body, because the body's AAD binds
 *  the initiator's fingerprint. It carries the initiator's real identity keys
 *  plus an Ed25519 signature that binds them to this session:
 *
 *    sig = Ed25519.sign(ik_sk,
 *            "veil.intro.v1|" || initiatorEphemeralDhPk || recipientIk || recipientXk)
 *
 *  - The ephemeral DH key is the one that seeded the session, so an intro
 *    cannot be lifted into a different session.
 *  - The recipient's keys are included, so an intro cannot be forwarded to a
 *    different recipient.
 *
 *  This authenticates the initiator (audit A-03) and gives the recipient the
 *  initiator's exchange key, which is what replies are routed to. It does not
 *  add X3DH-style forward secrecy for the first flight; that is a later step.
 * ============================================================================
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  aeadDecrypt,
  aeadEncrypt,
  computeFingerprint,
  fromB64,
  packSealed,
  toB64,
  unpackSealed,
  type MaskIdentity,
} from '../crypto/keys';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const INTRO_LABEL = encoder.encode('veil.intro.v1|');

export interface Intro {
  ik: Uint8Array;
  xk: Uint8Array;
  sig: Uint8Array;
}

export interface InnerPayload {
  body: string;
}

function introPreimage(
  ephemeralDhPk: Uint8Array,
  recipientIk: Uint8Array,
  recipientXk: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(INTRO_LABEL.length + 96);
  out.set(INTRO_LABEL, 0);
  out.set(ephemeralDhPk, INTRO_LABEL.length);
  out.set(recipientIk, INTRO_LABEL.length + 32);
  out.set(recipientXk, INTRO_LABEL.length + 64);
  return out;
}

export function createIntro(
  sender: MaskIdentity,
  ephemeralDhPk: Uint8Array,
  recipientIk: Uint8Array,
  recipientXk: Uint8Array,
): Intro {
  const sig = ed25519.sign(introPreimage(ephemeralDhPk, recipientIk, recipientXk), sender.signSk);
  return { ik: new Uint8Array(sender.signPk), xk: new Uint8Array(sender.dhPk), sig };
}

/**
 * Verifies an intro against the session's ephemeral key and our own keys.
 * Returns the initiator's fingerprint on success, null otherwise.
 */
export function verifyIntro(
  intro: Intro,
  ephemeralDhPk: Uint8Array,
  recipient: MaskIdentity,
): string | null {
  if (intro.ik.length !== 32 || intro.xk.length !== 32 || intro.sig.length !== 64) return null;
  try {
    const ok = ed25519.verify(
      intro.sig,
      introPreimage(ephemeralDhPk, recipient.signPk, recipient.dhPk),
      intro.ik,
    );
    return ok ? computeFingerprint(intro.ik, intro.xk) : null;
  } catch {
    return null;
  }
}

export function encodeInner(payload: InnerPayload): Uint8Array {
  return encoder.encode(JSON.stringify({ v: 1, body: payload.body }));
}

/** Returns null for anything that is not a well-formed v1 body payload. */
export function decodeInner(bytes: Uint8Array): InnerPayload | null {
  try {
    const obj = JSON.parse(decoder.decode(bytes));
    if (!obj || obj.v !== 1 || typeof obj.body !== 'string') return null;
    return { body: obj.body };
  } catch {
    return null;
  }
}

const introAad = (dhPk: string) => encoder.encode(`veil.intro.v2|${dhPk}`);

/** Seals an intro for the envelope. `dhPk` is the header's (b64u) DH key. */
export function sealIntro(intro: Intro, introKey: Uint8Array, dhPk: string): string {
  const json = JSON.stringify({ ik: toB64(intro.ik), xk: toB64(intro.xk), sig: toB64(intro.sig) });
  return packSealed(aeadEncrypt(introKey, encoder.encode(json), introAad(dhPk)));
}

export function openIntro(packed: string, introKey: Uint8Array, dhPk: string): Intro | null {
  const sealed = unpackSealed(packed);
  if (!sealed) return null;
  const pt = aeadDecrypt(introKey, sealed, introAad(dhPk));
  if (!pt) return null;
  try {
    const { ik, xk, sig } = JSON.parse(decoder.decode(pt));
    if (typeof ik !== 'string' || typeof xk !== 'string' || typeof sig !== 'string') return null;
    return { ik: fromB64(ik), xk: fromB64(xk), sig: fromB64(sig) };
  } catch {
    return null;
  }
}
