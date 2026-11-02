/**
 * ============================================================================
 *  VEIL — SEALED ENVELOPE (wire v2)
 * ============================================================================
 *  Every byte the relay stores is ciphertext. Layout, exactly 4,096 bytes:
 *
 *    [0]        version 0x02
 *    [1..24]    XChaCha20-Poly1305 nonce (24 B)
 *    [25..4095] AEAD(headerKey, aad = "veil.env.v2|" inbox, pad(inner)) (4,055 B + 16 B tag)
 *
 *  `pad(inner)` is a 2-byte length, the UTF-8 JSON below, then random bytes
 *  to exactly 4,055 bytes. The length prefix and padding are INSIDE the AEAD,
 *  so the relay learns neither message length nor any header field
 *  (audit A-02). Binding the inbox into the AAD stops an envelope being
 *  replayed into a different inbox.
 *
 *  Inner JSON:
 *    { "h": { dhPk, pn, n, retention, ttlMs?, msgId },   ratchet header
 *      "i"?: "<packed sealed intro>",                    first-contact only
 *      "n": "<b64u body nonce>",
 *      "c": "<b64u body ciphertext>" }
 *
 *  Sender and recipient fingerprints are NOT on the wire: the inbox an
 *  envelope arrives on already identifies the conversation.
 * ============================================================================
 */

import { aeadDecrypt, aeadEncrypt, fromB64, toB64 } from '../crypto/keys';
import { padEnvelope, unpadEnvelope, ENVELOPE_BYTE_SIZE } from '../crypto/padding';
import { bytesToBase64, base64ToBytes } from './EnvelopeCodec';
import type { RatchetHeader } from '../types/models';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const VERSION = 0x02;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const INNER_BYTES = ENVELOPE_BYTE_SIZE - 1 - NONCE_BYTES - TAG_BYTES; // 4055

export type WireHeader = Omit<RatchetHeader, 'senderFp' | 'recipientFp'>;

export interface InnerEnvelope {
  header: WireHeader;
  /** Packed sealed intro (see protocol/intro.ts), first contact only. */
  intro?: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

const aadFor = (inbox: string) => encoder.encode(`veil.env.v2|${inbox}`);

/** Strips anything the wire must not carry from a ratchet header. */
export const toWireHeader = (h: RatchetHeader): WireHeader => ({
  dhPk: h.dhPk,
  pn: h.pn,
  n: h.n,
  retention: h.retention,
  ...(h.ttlMs !== undefined ? { ttlMs: h.ttlMs } : {}),
  msgId: h.msgId,
});

/** Seals an inner envelope into a base64 string of exactly 4,096 bytes. */
export function sealEnvelope(headerKey: Uint8Array, inbox: string, inner: InnerEnvelope): string {
  const json: Record<string, unknown> = {
    h: inner.header,
    n: toB64(inner.nonce),
    c: toB64(inner.ciphertext),
  };
  if (inner.intro) json.i = inner.intro;

  // Throws if the inner JSON does not fit; callers bound the body size.
  const padded = padEnvelope(encoder.encode(JSON.stringify(json)), INNER_BYTES);
  const sealed = aeadEncrypt(headerKey, padded, aadFor(inbox));

  const out = new Uint8Array(ENVELOPE_BYTE_SIZE);
  out[0] = VERSION;
  out.set(sealed.nonce, 1);
  out.set(sealed.ciphertext, 1 + NONCE_BYTES);
  return bytesToBase64(out);
}

/** Returns null for anything that is not a v2 envelope sealed for this inbox. */
export function openEnvelope(
  headerKey: Uint8Array,
  inbox: string,
  b64: string,
): InnerEnvelope | null {
  try {
    const raw = base64ToBytes(b64);
    if (raw.length !== ENVELOPE_BYTE_SIZE || raw[0] !== VERSION) return null;
    const padded = aeadDecrypt(
      headerKey,
      { nonce: raw.slice(1, 1 + NONCE_BYTES), ciphertext: raw.slice(1 + NONCE_BYTES) },
      aadFor(inbox),
    );
    if (!padded) return null;
    const body = unpadEnvelope(padded, INNER_BYTES);
    if (!body) return null;

    const obj = JSON.parse(decoder.decode(body));
    const h = obj?.h;
    if (
      !h ||
      typeof h.dhPk !== 'string' ||
      typeof h.n !== 'number' ||
      typeof h.pn !== 'number' ||
      typeof h.msgId !== 'string' ||
      typeof h.retention !== 'string' ||
      (h.ttlMs !== undefined && typeof h.ttlMs !== 'number') ||
      typeof obj.n !== 'string' ||
      typeof obj.c !== 'string' ||
      (obj.i !== undefined && typeof obj.i !== 'string')
    ) {
      return null;
    }
    return {
      header: {
        dhPk: h.dhPk,
        pn: h.pn,
        n: h.n,
        retention: h.retention,
        ...(h.ttlMs !== undefined ? { ttlMs: h.ttlMs } : {}),
        msgId: h.msgId,
      },
      intro: obj.i,
      nonce: fromB64(obj.n),
      ciphertext: fromB64(obj.c),
    };
  } catch {
    return null;
  }
}
