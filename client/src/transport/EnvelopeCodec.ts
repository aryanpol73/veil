/**
 * ============================================================================
 *  VEIL — ENVELOPE CODEC
 * ============================================================================
 *  Encodes and decodes versioned message envelopes into exactly 4,096-byte
 *  padded Base64 envelopes for transport across the blind relay.
 * ============================================================================
 */

import { toB64, fromB64 } from '../crypto/keys';
import { padEnvelope, unpadEnvelope, ENVELOPE_BYTE_SIZE } from '../crypto/padding';
import type { RatchetHeader, WireEnvelope } from '../types/models';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (s: string) => encoder.encode(s);
const fromUtf8 = (b: Uint8Array) => decoder.decode(b);

/**
 * Standard Base64 encoder for binary Uint8Array ensuring correct padding for Node.js Buffer compatibility.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  const len = bytes.length;
  let i = 0;

  for (; i + 2 < len; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += chars[((b1 & 15) << 2) | (b2 >> 6)];
    out += chars[b2 & 63];
  }

  if (i < len) {
    const b0 = bytes[i];
    out += chars[b0 >> 2];
    if (i + 1 < len) {
      const b1 = bytes[i + 1];
      out += chars[((b0 & 3) << 4) | (b1 >> 4)];
      out += chars[(b1 & 15) << 2];
      out += '=';
    } else {
      out += chars[(b0 & 3) << 4];
      out += '==';
    }
  }

  return out;
}

/**
 * Standard / URL Base64 decoder returning Uint8Array.
 */
export function base64ToBytes(str: string): Uint8Array {
  return fromB64(str);
}

export interface EncodeEnvelopeParams {
  inbox: string;
  header: RatchetHeader;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  id?: string;
}

export const EnvelopeCodec = {
  /**
   * Encodes a logical envelope into a fixed 4096-byte padded Base64 string.
   */
  encode(params: EncodeEnvelopeParams): string {
    const logical = {
      v: 1,
      id: params.id ?? '',
      inbox: params.inbox,
      header: params.header,
      nonce: toB64(params.nonce),
      ciphertext: toB64(params.ciphertext),
    };

    const json = JSON.stringify(logical);
    const jsonBytes = utf8(json);

    const paddedBytes = padEnvelope(jsonBytes, ENVELOPE_BYTE_SIZE);
    return bytesToBase64(paddedBytes);
  },

  /**
   * Decodes a fixed 4096-byte padded Base64 envelope back into a logical WireEnvelope.
   * Returns null if unpadding, JSON parsing, or validation fails.
   */
  decode(base64Payload: string): WireEnvelope | null {
    try {
      const paddedBytes = base64ToBytes(base64Payload);
      if (paddedBytes.length !== ENVELOPE_BYTE_SIZE) {
        return null;
      }

      const unpadded = unpadEnvelope(paddedBytes, ENVELOPE_BYTE_SIZE);
      if (!unpadded) {
        return null;
      }

      const jsonStr = fromUtf8(unpadded);
      const parsed = JSON.parse(jsonStr);

      if (
        !parsed ||
        parsed.v !== 1 ||
        typeof parsed.inbox !== 'string' ||
        !parsed.header ||
        typeof parsed.header.dhPk !== 'string' ||
        typeof parsed.header.n !== 'number' ||
        typeof parsed.header.msgId !== 'string' ||
        typeof parsed.nonce !== 'string' ||
        typeof parsed.ciphertext !== 'string'
      ) {
        return null;
      }

      return {
        v: 1,
        id: parsed.id ?? '',
        inbox: parsed.inbox,
        header: parsed.header,
        nonce: parsed.nonce,
        ciphertext: parsed.ciphertext,
      };
    } catch {
      return null;
    }
  },
};

export default EnvelopeCodec;
