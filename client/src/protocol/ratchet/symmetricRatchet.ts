/**
 * ============================================================================
 *  VEIL — SYMMETRIC CHAIN RATCHET
 * ============================================================================
 */

import { deriveSubSeed, CRYPTO } from '../../crypto/keys';

const LBL = {
  chainStep: 'veil.ratchet.chain.v1',
  msgKey: 'veil.ratchet.msgkey.v1',
};

export interface SymmetricStepResult {
  nextChainKey: Uint8Array;
  messageKey: Uint8Array;
}

/**
 * Advances a symmetric chain key by one step.
 * Returns the next chain key (which advances forward secrecy) and the one-shot message key.
 */
export function stepSymmetricChain(chainKey: Uint8Array): SymmetricStepResult {
  return {
    nextChainKey: deriveSubSeed(chainKey, LBL.chainStep, CRYPTO.AEAD_KEY_BYTES),
    messageKey: deriveSubSeed(chainKey, LBL.msgKey, CRYPTO.AEAD_KEY_BYTES),
  };
}

export default {
  stepSymmetricChain,
};
