/**
 * ============================================================================
 *  VEIL — ENVELOPE PADDING & UNPADDING
 * ============================================================================
 *  Uniform fixed-size envelopes deny packet size correlation attacks.
 *  The relay requires all message envelopes to decode to exactly 4,096 bytes.
 *
 *  Framing format:
 *   [0..1]    uint16 BE: actual payload length L (0 <= L <= 4094)
 *   [2..2+L]  actual payload bytes
 *   [2+L..N]  random CSPRNG padding bytes filling to targetSize (4096)
 * ============================================================================
 */

import { randomBytes } from './keys';

export const ENVELOPE_BYTE_SIZE = 4096;

/**
 * Pads arbitrary byte payload to exactly targetSize (default 4096 bytes).
 * Throws if the payload exceeds targetSize - 2 bytes.
 */
export function padEnvelope(
  payload: Uint8Array,
  targetSize: number = ENVELOPE_BYTE_SIZE,
): Uint8Array {
  if (payload.length > targetSize - 2) {
    throw new Error(
      `[veil/padding] payload length (${payload.length}) exceeds maximum capacity (${targetSize - 2})`,
    );
  }

  const out = new Uint8Array(targetSize);
  const len = payload.length;

  // 2-byte big-endian length prefix
  out[0] = (len >> 8) & 0xff;
  out[1] = len & 0xff;

  // Payload content
  out.set(payload, 2);

  // Remainder filled with pseudo-random bytes so padded frames look like high-entropy ciphertext
  const padLen = targetSize - 2 - len;
  if (padLen > 0) {
    const pad = randomBytes(padLen);
    out.set(pad, 2 + len);
  }

  return out;
}

/**
 * Extracts the original payload from a padded envelope.
 * Returns null if the envelope is malformed or smaller than the declared length.
 */
export function unpadEnvelope(
  padded: Uint8Array,
  targetSize: number = ENVELOPE_BYTE_SIZE,
): Uint8Array | null {
  if (padded.length !== targetSize) {
    return null;
  }

  const len = (padded[0] << 8) | padded[1];
  if (len < 0 || len > targetSize - 2) {
    return null;
  }

  return padded.slice(2, 2 + len);
}

export default {
  ENVELOPE_BYTE_SIZE,
  padEnvelope,
  unpadEnvelope,
};
