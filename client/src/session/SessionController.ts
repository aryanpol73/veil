/**
 * ============================================================================
 *  VEIL — SESSION CONTROLLER
 * ============================================================================
 *  The one place a vault session starts and ends. Every component that holds
 *  vault-derived state is wired up in `beginSession` and torn down in
 *  `endSession`, so locking cannot leave keys, subscriptions or cached
 *  ratchets behind (audit A-10).
 *
 *  Teardown order matters: stop the network first so nothing is received or
 *  ACKed mid-teardown, then drop key material, then close the vault.
 * ============================================================================
 */

import { wipe, type MaskIdentity } from '../crypto/keys';
import { identityManager } from '../identity/IdentityManager';
import { messageService } from '../messaging/MessageService';
import { ratchetManager } from '../messaging/RatchetManager';
import { activeMaskIndex, loadSealedMasterSeed, lockVault, RamVault } from '../storage/db';
import { relayClient } from '../transport/RelayClient';

/**
 * Call right after a successful unlock. Derives the vault's identity from its
 * sealed seed and starts messaging. Returns null if the seed is unreadable.
 */
export function beginSession(): MaskIdentity | null {
  const seed = loadSealedMasterSeed();
  if (!seed) return null;
  try {
    const mask = identityManager.setIdentity(seed, activeMaskIndex());
    messageService.setActiveMask(mask);
    return mask;
  } finally {
    wipe(seed);
  }
}

let ending: Promise<void> | null = null;

/** Locks everything. Safe to call repeatedly; concurrent calls share one run. */
export function endSession(): Promise<void> {
  if (ending) return ending;
  ending = (async () => {
    try {
      messageService.setActiveMask(null);
      relayClient.disconnect();
      ratchetManager.purge();
      identityManager.lock();
      RamVault.purgeAll();
      await lockVault();
    } finally {
      ending = null;
    }
  })();
  return ending;
}
