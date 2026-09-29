/**
 * ============================================================================
 *  VEIL — DOUBLE RATCHET SEND
 * ============================================================================
 *  Encrypts outbound messages:
 *   1. Advances symmetric sending chain to derive ephemeral message key.
 *   2. Constructs cryptographic AAD binding thread, counter, retention, and sender.
 *   3. Encrypts with XChaCha20-Poly1305.
 *   4. Zeroizes the message key immediately to ensure forward secrecy.
 * ============================================================================
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { aeadEncrypt, toB64, wipe, randomBytes } from '../../crypto/keys';
import type { RetentionMode } from '../../types/models';
import type { DoubleRatchetState, RatchetEncryptedPayload } from './state';
import { stepSymmetricChain } from './symmetricRatchet';

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);
const LBL_EXCHANGE = utf8('x25519.exchange').slice(0, 32);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

export function buildMessageAad(
  threadId: string,
  counter: number,
  retention: RetentionMode,
  senderFp: string,
  msgId: string,
): Uint8Array {
  return utf8(`veil.msg.v1|${threadId}|${counter}|${retention}|${senderFp}|${msgId}`);
}

export interface RatchetSendParams {
  state: DoubleRatchetState;
  plaintext: Uint8Array;
  threadId: string;
  retention: RetentionMode;
  senderFp: string;
  msgId: string;
  ttlMs?: number;
}

/**
 * Encrypts an outbound message using the active Double Ratchet state.
 */
export function ratchetEncryptMessage(params: RatchetSendParams): RatchetEncryptedPayload {
  const { state, plaintext, threadId, retention, senderFp, msgId, ttlMs } = params;

  // If sending chain key is not yet initialized (e.g. Bob answering Alice's initial message),
  // Bob generates a new local DH keypair and initializes the sending chain.
  if (!state.sendChainKey) {
    if (!state.remoteDhPk) {
      throw new Error('[veil/ratchet] cannot send: remote DH public key is missing');
    }
    const newLocal = x25519.keygen(randomBytes(32));
    const newSk = new Uint8Array(newLocal.secretKey);
    const newPk = new Uint8Array(newLocal.publicKey);

    const ss = x25519.getSharedSecret(newSk, state.remoteDhPk);
    const mixed = blake2b(concat(state.rootKey, ss), {
      dkLen: 64,
      key: LBL_EXCHANGE,
    });
    wipe(ss);

    state.rootKey = mixed.slice(0, 32);
    state.sendChainKey = mixed.slice(32, 64);
    wipe(mixed);

    wipe(state.localDhSk);
    state.localDhSk = newSk;
    state.localDhPk = newPk;
    state.prevChainLen = state.sendCounter;
    state.sendCounter = 0;
  }

  // Advance the sending chain
  const { nextChainKey, messageKey } = stepSymmetricChain(state.sendChainKey);
  wipe(state.sendChainKey);
  state.sendChainKey = nextChainKey;

  const counter = state.sendCounter;
  state.sendCounter += 1;

  // Build AAD binding all security parameters
  const aad = buildMessageAad(threadId, counter, retention, senderFp, msgId);

  // Encrypt with fresh 24-byte nonce
  const sealed = aeadEncrypt(messageKey, plaintext, aad);

  // Zeroize one-time message key immediately
  wipe(messageKey);

  return {
    header: {
      dhPk: toB64(state.localDhPk),
      pn: state.prevChainLen,
      n: counter,
      retention,
      ttlMs,
      msgId,
    },
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
  };
}

export default {
  ratchetEncryptMessage,
  buildMessageAad,
};
