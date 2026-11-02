/**
 * ============================================================================
 *  VEIL — INNER PAYLOAD & INITIATOR INTRODUCTION
 * ============================================================================
 *  Everything below lives INSIDE the ratchet AEAD; the relay never sees it.
 *
 *  Inner payload v1 (UTF-8 JSON):
 *    { "v": 1, "body": "<text>", "intro"?: { "ik", "xk", "sig" } }
 *
 *  The initiator (the party who imported an invite) attaches `intro` to every
 *  message until it has received a reply. It carries the initiator's real
 *  identity keys plus an Ed25519 signature that binds them to this session:
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
import { computeFingerprint, fromB64, toB64, type MaskIdentity } from '../crypto/keys';

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
  intro?: Intro;
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
  const obj: Record<string, unknown> = { v: 1, body: payload.body };
  if (payload.intro) {
    obj.intro = {
      ik: toB64(payload.intro.ik),
      xk: toB64(payload.intro.xk),
      sig: toB64(payload.intro.sig),
    };
  }
  return encoder.encode(JSON.stringify(obj));
}

/** Returns null for anything that is not a well-formed v1 inner payload. */
export function decodeInner(bytes: Uint8Array): InnerPayload | null {
  try {
    const obj = JSON.parse(decoder.decode(bytes));
    if (!obj || obj.v !== 1 || typeof obj.body !== 'string') return null;
    if (obj.intro === undefined) return { body: obj.body };
    const { ik, xk, sig } = obj.intro ?? {};
    if (typeof ik !== 'string' || typeof xk !== 'string' || typeof sig !== 'string') return null;
    return { body: obj.body, intro: { ik: fromB64(ik), xk: fromB64(xk), sig: fromB64(sig) } };
  } catch {
    return null;
  }
}
