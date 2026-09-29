/**
 * ============================================================================
 *  VEIL — DOUBLE RATCHET INITIALIZATION
 * ============================================================================
 *  Establishes initial cryptographic ratchet session state for Alice (initiator)
 *  and Bob (responder), deriving the initial root and chain keys via authenticated
 *  X25519 key agreement with BLAKE2b.
 * ============================================================================
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { randomBytes, wipe } from '../../crypto/keys';
import type { DoubleRatchetState } from './state';

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);
const LBL_INIT = utf8('veil.ratchet.init.v1');
const LBL_EXCHANGE = utf8('x25519.exchange').slice(0, 32);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

/**
 * Initializes a Double Ratchet session for Alice (the party initiating first contact).
 *
 * @param bobDhPk Bob's pre-shared X25519 public key (from an invitation).
 * @param aliceDhKeypair Optional local ephemeral keypair; generated if omitted.
 */
export function initAliceSession(
  bobDhPk: Uint8Array,
  aliceDhKeypair?: { secretKey: Uint8Array; publicKey: Uint8Array },
): DoubleRatchetState {
  if (bobDhPk.length !== 32) {
    throw new Error('[veil/ratchet] invalid remote DH public key length');
  }

  const kp =
    aliceDhKeypair ??
    (() => {
      const generated = x25519.keygen(randomBytes(32));
      return {
        secretKey: new Uint8Array(generated.secretKey),
        publicKey: new Uint8Array(generated.publicKey),
      };
    })();

  const ss = x25519.getSharedSecret(kp.secretKey, bobDhPk);
  const mixed = blake2b(concat(LBL_INIT, ss), {
    dkLen: 64,
    key: LBL_EXCHANGE,
  });
  wipe(ss);

  const rootKey = mixed.slice(0, 32);
  const sendChainKey = mixed.slice(32, 64);
  wipe(mixed);

  return {
    rootKey,
    sendChainKey,
    recvChainKey: null,
    localDhSk: new Uint8Array(kp.secretKey),
    localDhPk: new Uint8Array(kp.publicKey),
    remoteDhPk: new Uint8Array(bobDhPk),
    sendCounter: 0,
    recvCounter: 0,
    prevChainLen: 0,
    skippedKeys: new Map(),
  };
}

/**
 * Initializes a Double Ratchet session for Bob (the party accepting an invitation / receiving first contact).
 *
 * @param bobDhSk Bob's X25519 private key (corresponding to the public key published in the invite).
 * @param bobDhPk Bob's X25519 public key.
 * @param aliceDhPk Alice's ephemeral public key received in the initial message.
 */
export function initBobSession(
  bobDhSk: Uint8Array,
  bobDhPk: Uint8Array,
  aliceDhPk: Uint8Array,
): DoubleRatchetState {
  if (bobDhSk.length !== 32 || bobDhPk.length !== 32 || aliceDhPk.length !== 32) {
    throw new Error('[veil/ratchet] invalid key length in Bob session init');
  }

  const ss = x25519.getSharedSecret(bobDhSk, aliceDhPk);
  const mixed = blake2b(concat(LBL_INIT, ss), {
    dkLen: 64,
    key: LBL_EXCHANGE,
  });
  wipe(ss);

  const rootKey = mixed.slice(0, 32);
  const recvChainKey = mixed.slice(32, 64);
  wipe(mixed);

  return {
    rootKey,
    sendChainKey: null,
    recvChainKey,
    localDhSk: new Uint8Array(bobDhSk),
    localDhPk: new Uint8Array(bobDhPk),
    remoteDhPk: new Uint8Array(aliceDhPk),
    sendCounter: 0,
    recvCounter: 0,
    prevChainLen: 0,
    skippedKeys: new Map(),
  };
}

export default {
  initAliceSession,
  initBobSession,
};
