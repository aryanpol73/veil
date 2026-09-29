/**
 * ============================================================================
 *  VEIL — DIFFIE-HELLMAN RATCHET STEP
 * ============================================================================
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { wipe, randomBytes } from '../../crypto/keys';
import type { DoubleRatchetState } from './state';

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);
const LBL_EXCHANGE = utf8('x25519.exchange').slice(0, 32);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

/**
 * Performs a DH ratchet step when a message from the remote party carries
 * a new remote DH public key.
 *
 * Derives a new receiving chain key, generates a fresh local DH keypair,
 * and derives a new sending chain key and root key.
 */
export function performDhRatchetStep(
  state: DoubleRatchetState,
  newRemoteDhPk: Uint8Array,
): void {
  // Step 1: Compute shared secret with existing local private key and new remote public key
  const sharedRecv = x25519.getSharedSecret(state.localDhSk, newRemoteDhPk);
  const mixedRecv = blake2b(concat(state.rootKey, sharedRecv), {
    dkLen: 64,
    key: LBL_EXCHANGE,
  });
  wipe(sharedRecv);

  const tempRoot = mixedRecv.slice(0, 32);
  const nextRecvChainKey = mixedRecv.slice(32, 64);
  wipe(mixedRecv);

  // Step 2: Generate fresh local DH keypair
  const newLocalKeygen = x25519.keygen(randomBytes(32));
  const newLocalSk = new Uint8Array(newLocalKeygen.secretKey);
  const newLocalPk = new Uint8Array(newLocalKeygen.publicKey);

  // Step 3: Compute shared secret with new local private key and new remote public key
  const sharedSend = x25519.getSharedSecret(newLocalSk, newRemoteDhPk);
  const mixedSend = blake2b(concat(tempRoot, sharedSend), {
    dkLen: 64,
    key: LBL_EXCHANGE,
  });
  wipe(sharedSend, tempRoot);

  const nextRootKey = mixedSend.slice(0, 32);
  const nextSendChainKey = mixedSend.slice(32, 64);
  wipe(mixedSend);

  // Wipe previous local secret key
  wipe(state.localDhSk);

  // Step 4: Advance ratchet state
  state.prevChainLen = state.sendCounter;
  state.sendCounter = 0;
  state.recvCounter = 0;
  state.rootKey = nextRootKey;
  state.recvChainKey = nextRecvChainKey;
  state.sendChainKey = nextSendChainKey;
  state.localDhSk = newLocalSk;
  state.localDhPk = newLocalPk;
  state.remoteDhPk = new Uint8Array(newRemoteDhPk);
}

export default {
  performDhRatchetStep,
};
