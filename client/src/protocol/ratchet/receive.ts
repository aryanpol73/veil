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
import {
  MAX_CHAIN_SKIP,
  cloneRatchetState,
  commitRatchetState,
  type DoubleRatchetState,
  type RatchetEncryptedPayload,
} from './state';
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
 *
 * CRITICAL SECURITY INVARIANT:
 * Never mutates live `state` unless AEAD authentication succeeds. Operates on a tentative
 * cloned working state so forged or corrupted packets cannot brick or desynchronize ratchet sessions.
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

  // Work on a tentative cloned state to prevent ratchet state desynchronization
  // if authentication fails or a packet is malformed/forged.
  const workingState = cloneRatchetState(state);

  // 1. Check if message key was already computed and cached as a skipped key
  const cachedKey = consumeSkippedKey(workingState, remoteDhPk, header.n);
  if (cachedKey) {
    const aad = buildMessageAad(
      threadId,
      header.n,
      header.retention,
      senderFp,
      header.msgId,
      header.ttlMs ?? 0,
      header.dhPk,
    );
    const plaintext = aeadDecrypt(cachedKey, { nonce, ciphertext }, aad);
    wipe(cachedKey);
    if (plaintext) {
      commitRatchetState(state, workingState);
      return plaintext;
    }
    return null;
  }

  // 2. Check if a DH ratchet step is needed (remote DH public key changed)
  const isNewRemoteKey =
    !workingState.remoteDhPk || !timingSafeEqual(workingState.remoteDhPk, remoteDhPk);

  if (isNewRemoteKey) {
    // If we have an active receiving chain, skip any remaining unreceived keys up to header.pn
    if (workingState.recvChainKey && workingState.remoteDhPk) {
      if (header.pn < workingState.recvCounter) {
        // Inconsistent previous chain length
        return null;
      }
      if (header.pn - workingState.recvCounter > MAX_CHAIN_SKIP) {
        return null;
      }
      while (workingState.recvCounter < header.pn) {
        const { nextChainKey, messageKey } = stepSymmetricChain(workingState.recvChainKey);
        wipe(workingState.recvChainKey);
        workingState.recvChainKey = nextChainKey;
        storeSkippedKey(workingState, workingState.remoteDhPk, workingState.recvCounter, messageKey);
        wipe(messageKey);
        workingState.recvCounter += 1;
      }
    }

    // Execute DH ratchet transition on tentative working state
    performDhRatchetStep(workingState, remoteDhPk);
  }

  // 3. Ensure we have an active receiving chain
  if (!workingState.recvChainKey) {
    return null;
  }

  // 4. Reject past messages that were not in the skipped keys cache (duplicate/replay)
  if (header.n < workingState.recvCounter) {
    return null;
  }

  // 5. Reject excessive skips to prevent memory exhaustion DoS
  if (header.n - workingState.recvCounter > MAX_CHAIN_SKIP) {
    return null;
  }

  // 6. Skip and cache any intermediate message keys ahead of header.n
  while (workingState.recvCounter < header.n) {
    const { nextChainKey, messageKey } = stepSymmetricChain(workingState.recvChainKey);
    wipe(workingState.recvChainKey);
    workingState.recvChainKey = nextChainKey;
    storeSkippedKey(workingState, workingState.remoteDhPk!, workingState.recvCounter, messageKey);
    wipe(messageKey);
    workingState.recvCounter += 1;
  }

  // 7. Derive the target message key
  const { nextChainKey, messageKey } = stepSymmetricChain(workingState.recvChainKey);
  wipe(workingState.recvChainKey);
  workingState.recvChainKey = nextChainKey;
  workingState.recvCounter += 1;

  // 8. Verify AAD and decrypt
  const aad = buildMessageAad(
    threadId,
    header.n,
    header.retention,
    senderFp,
    header.msgId,
    header.ttlMs ?? 0,
    header.dhPk,
  );
  const plaintext = aeadDecrypt(messageKey, { nonce, ciphertext }, aad);
  wipe(messageKey);

  if (!plaintext) {
    // Authentication failed: discard workingState completely. Live state remains untouched!
    return null;
  }

  // Authentication succeeded: commit working state to live state
  commitRatchetState(state, workingState);
  return plaintext;
}

export default {
  ratchetDecryptMessage,
};
