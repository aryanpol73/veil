/**
 * ============================================================================
 *  VEIL — IDENTITY MANAGER
 * ============================================================================
 *  Manages the lifecycle of cryptographic identities (Masks) in memory.
 *  Secret keys are wiped from memory on lock or background.
 * ============================================================================
 */

import {
  deriveMask,
  destroyMask,
  computeFingerprint,
  type MaskIdentity,
  toHex,
} from '../crypto/keys';
import { blake2b } from '@noble/hashes/blake2.js';

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);

export class IdentityManager {
  private activeMask: MaskIdentity | null = null;
  private deviceFingerprint: string | null = null;

  public setIdentity(masterSeed: Uint8Array, maskIndex: number): MaskIdentity {
    if (this.activeMask) {
      destroyMask(this.activeMask);
    }

    this.activeMask = deriveMask(masterSeed, maskIndex);

    // Compute stable device fingerprint
    const fpDigest = blake2b(utf8(`veil.device.${toHex(masterSeed.slice(0, 16))}`), {
      dkLen: 16,
    });
    this.deviceFingerprint = `V1-${toHex(fpDigest).slice(0, 8).toUpperCase()}`;

    return this.activeMask;
  }

  public getActiveMask(): MaskIdentity | null {
    return this.activeMask;
  }

  public getDeviceFingerprint(): string {
    return this.deviceFingerprint ?? 'V1-INITIAL';
  }

  public lock(): void {
    if (this.activeMask) {
      destroyMask(this.activeMask);
      this.activeMask = null;
    }
  }
}

export const identityManager = new IdentityManager();
export default identityManager;
