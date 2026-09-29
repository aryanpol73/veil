/**
 * ============================================================================
 *  VEIL — KEYCHAIN & SECURE STORAGE ABSTRACTION
 * ============================================================================
 *  Stores the device salt (and only the device salt). The master seed and PIN
 *  are never stored in the OS keystore.
 *  Provides a web/test safe in-memory fallback for web preview and unit tests.
 * ============================================================================
 */

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
      return memoryStore.get(key) ?? null;
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
      memoryStore.set(key, value);
    }
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
