/**
 * ============================================================================
 *  VEIL — KEYCHAIN & SECURE STORAGE ABSTRACTION
 * ============================================================================
 *  Stores the device salt (and only the device salt). The master seed and PIN
 *  are never stored in the OS keystore.
 *
 *  On native builds every keystore failure throws. An in-memory fallback
 *  there would hold the salt only until the process dies, after which both
 *  vaults become permanently unopenable (audit A-13). The in-memory store is
 *  used only on web preview and in Node tests, where no keystore exists.
 * ============================================================================
 */

export class KeystoreUnavailableError extends Error {
  constructor(op: string) {
    super(`[veil/keychain] secure keystore ${op} failed`);
  }
}

let SecureStore: any = null;
let isNative = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RN = require('react-native');
  if (RN?.Platform?.OS === 'android' || RN?.Platform?.OS === 'ios') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SecureStore = require('expo-secure-store');
    isNative = typeof SecureStore?.getItemAsync === 'function';
  }
} catch {
  isNative = false;
}

const memoryStore = new Map<string, string>();

export const Keychain = {
  async getItem(key: string): Promise<string | null> {
    if (!isNative || !SecureStore) {
      return memoryStore.get(key) ?? null;
    }
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      throw new KeystoreUnavailableError('read');
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    if (!isNative || !SecureStore) {
      memoryStore.set(key, value);
      return;
    }
    try {
      await SecureStore.setItemAsync(key, value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        requireAuthentication: false,
      });
    } catch {
      throw new KeystoreUnavailableError('write');
    }
    // Read back: a write that did not stick would lose the salt on restart.
    let stored: string | null = null;
    try {
      stored = await SecureStore.getItemAsync(key);
    } catch {
      stored = null;
    }
    if (stored !== value) throw new KeystoreUnavailableError('verify');
  },

  async deleteItem(key: string): Promise<void> {
    memoryStore.delete(key);
    if (isNative && SecureStore) {
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        /* ignore */
      }
    }
  },

  purgeMemory(): void {
    memoryStore.clear();
  },
};

export default Keychain;
