/**
 * ============================================================================
 *  VEIL — DOUBLE RATCHET RECEIVE
 * ============================================================================
 *  Decrypts inbound messages:
 *   1. Checks skipped message keys for late-delivered out-of-order messages.
 *   2. If a new remote DH public key is presented, advances past previous skipped keys
 *      and executes a DH ratchet step.
 *   3. Skips and caches any skipped keys in the current chain up to header.n.
 *   4. Derives the ephemeral message key and validates AAD.
 *   5. Decrypts via XChaCha20-Poly1305.
 *   6. Rejects replayed, duplicate, or tampered messages.
 * ============================================================================
 */

import { aeadDecrypt, fromB64, timingSafeEqual, wipe } from '../../crypto/keys';
import { performDhRatchetStep } from './dhRatchet';
import { buildMessageAad } from './send';
import { consumeSkippedKey, storeSkippedKey } from './skippedKeys';
import { MAX_CHAIN_SKIP, type DoubleRatchetState, type RatchetEncryptedPayload } from './state';
import { stepSymmetricChain } from './symmetricRatchet';

export interface RatchetReceiveParams {
  state: DoubleRatchetState;
  payload: RatchetEncryptedPayload;
  threadId: string;
  senderFp: string;
}

/**
 * Decrypts an inbound message and advances the Double Ratchet state.
 * Returns the decrypted plaintext as a Uint8Array, or null if decryption/authentication fails.
 */
export function ratchetDecryptMessage(params: RatchetReceiveParams): Uint8Array | null {
  const { state, payload, threadId, senderFp } = params;
  const { header, nonce, ciphertext } = payload;

  let remoteDhPk: Uint8Array;
  try {
    remoteDhPk = fromB64(header.dhPk);
    if (remoteDhPk.length !== 32) return null;
  } catch {
    return null;
  }

  // 1. Check if message key was already computed and cached as a skipped key
  const cachedKey = consumeSkippedKey(state, remoteDhPk, header.n);
  if (cachedKey) {
    const aad = buildMessageAad(threadId, header.n, header.retention, senderFp, header.msgId);
    const plaintext = aeadDecrypt(cachedKey, { nonce, ciphertext }, aad);
    wipe(cachedKey);
    return plaintext;
  }

  // 2. Check if a DH ratchet step is needed (remote DH public key changed)
  const isNewRemoteKey =
    !state.remoteDhPk || !timingSafeEqual(state.remoteDhPk, remoteDhPk);

  if (isNewRemoteKey) {
    // If we have an active receiving chain, skip any remaining unreceived keys up to header.pn
    if (state.recvChainKey && state.remoteDhPk) {
      if (header.pn < state.recvCounter) {
        // Inconsistent previous chain length
        return null;
      }
      if (header.pn - state.recvCounter > MAX_CHAIN_SKIP) {
        return null;
      }
      while (state.recvCounter < header.pn) {
        const { nextChainKey, messageKey } = stepSymmetricChain(state.recvChainKey);
        wipe(state.recvChainKey);
        state.recvChainKey = nextChainKey;
        storeSkippedKey(state, state.remoteDhPk, state.recvCounter, messageKey);
        wipe(messageKey);
        state.recvCounter += 1;
      }
    }

    // Execute DH ratchet transition
    performDhRatchetStep(state, remoteDhPk);
  }

  // 3. Ensure we have an active receiving chain
  if (!state.recvChainKey) {
    return null;
  }

  // 4. Reject past messages that were not in the skipped keys cache (duplicate/replay)
  if (header.n < state.recvCounter) {
    return null;
  }

  // 5. Reject excessive skips to prevent memory exhaustion DoS
  if (header.n - state.recvCounter > MAX_CHAIN_SKIP) {
    return null;
  }

  // 6. Skip and cache any intermediate message keys ahead of header.n
  while (state.recvCounter < header.n) {
    const { nextChainKey, messageKey } = stepSymmetricChain(state.recvChainKey);
    wipe(state.recvChainKey);
    state.recvChainKey = nextChainKey;
    storeSkippedKey(state, state.remoteDhPk!, state.recvCounter, messageKey);
    wipe(messageKey);
    state.recvCounter += 1;
  }

  // 7. Derive the target message key
  const { nextChainKey, messageKey } = stepSymmetricChain(state.recvChainKey);
  wipe(state.recvChainKey);
  state.recvChainKey = nextChainKey;
  state.recvCounter += 1;

  // 8. Verify AAD and decrypt
  const aad = buildMessageAad(threadId, header.n, header.retention, senderFp, header.msgId);
  const plaintext = aeadDecrypt(messageKey, { nonce, ciphertext }, aad);
  wipe(messageKey);

  return plaintext;
}

export default {
  ratchetDecryptMessage,
};
