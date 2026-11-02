/**
 * ============================================================================
 *  VEIL — AT-REST ENCRYPTION GUARDS (audit A-13)
 * ============================================================================
 *  Uses a real SQLite driver dressed up as a native (SQLCipher-requiring)
 *  driver, so the vault's fail-closed checks and key handling can be tested
 *  in Node.
 * ============================================================================
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMask, deriveVaultKey, fromB64, generateMasterSeed, toHex } from '../client/src/crypto/keys';
import {
  lockVault,
  provisionVaults,
  setSqlDriver,
  unlockWithPin,
  VaultEncryptionUnavailableError,
  type SqlConnection,
  type SqlDriver,
} from '../client/src/storage/db';
import { Keychain } from '../client/src/storage/keychain';
import { resetLimiter } from '../client/src/storage/attemptLimiter';
import { createNodeSqliteDriver } from './helpers/nodeSqliteDriver';

const MASTER = '864213';
const GHOST = '97531864';

function cipherDriver(opts: { cipherVersion: string | null }) {
  const base = createNodeSqliteDriver();
  const keysSeen: string[] = [];
  const driver: SqlDriver & { dispose: () => void } = {
    requiresCipher: true,
    dispose: base.dispose,
    open(name: string): SqlConnection {
      const conn = base.open(name);
      return {
        ...conn,
        execute(sql: string, params?: any[]) {
          const t = sql.trim();
          if (/^PRAGMA cipher_version$/i.test(t)) {
            return {
              rows: opts.cipherVersion ? [{ cipher_version: opts.cipherVersion }] : [],
              rowsAffected: 0,
            };
          }
          const key = t.match(/^PRAGMA key = "x'([0-9a-f]+)'"$/i);
          if (key) {
            keysSeen.push(key[1]);
            return { rows: [], rowsAffected: 0 };
          }
          if (/^PRAGMA cipher_/i.test(t)) return { rows: [], rowsAffected: 0 };
          return conn.execute(sql, params);
        },
      };
    },
  };
  return { driver, keysSeen };
}

const seeds = () => {
  const p = generateMasterSeed();
  const g = generateMasterSeed();
  return {
    masterPin: MASTER,
    ghostPin: GHOST,
    primaryFingerprint: deriveMask(p, 0).fingerprint,
    ghostFingerprint: deriveMask(g, 1).fingerprint,
    primarySeed: p,
    ghostSeed: g,
  };
};

describe('Vault at-rest encryption guards', () => {
  const disposers: Array<() => void> = [];
  after(async () => {
    await lockVault();
    for (const d of disposers) d();
  });

  it('refuses to provision when the build has no SQLCipher', async () => {
    Keychain.purgeMemory();
    const { driver } = cipherDriver({ cipherVersion: null });
    disposers.push(driver.dispose);
    setSqlDriver(driver);
    await assert.rejects(provisionVaults(seeds()), VaultEncryptionUnavailableError);
  });

  it('keys SQLCipher with a subkey distinct from the Argon2id output', async () => {
    Keychain.purgeMemory();
    await resetLimiter();
    const { driver, keysSeen } = cipherDriver({ cipherVersion: '4.6.1 community' });
    disposers.push(driver.dispose);
    setSqlDriver(driver);
    await provisionVaults(seeds());

    const res = await unlockWithPin(MASTER);
    assert.equal(res.ok, true);
    assert.ok(keysSeen.length >= 2);

    const salt = fromB64((await Keychain.getItem('veil.vault.device_salt.v1'))!);
    const master = toHex(deriveVaultKey(MASTER, salt, 'partition.primary'));
    const ghost = toHex(deriveVaultKey(GHOST, salt, 'partition.decoy'));
    for (const k of keysSeen) {
      assert.notEqual(k, master, 'SQLCipher never receives the raw Argon2id output');
      assert.notEqual(k, ghost);
    }
  });
});
