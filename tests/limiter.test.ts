/**
 * ============================================================================
 *  VEIL — PIN ATTEMPT LIMITER TESTS (audit A-12)
 * ============================================================================
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateMasterSeed, deriveMask } from '../client/src/crypto/keys';
import { lockVault, provisionVaults, setSqlDriver, unlockWithPin } from '../client/src/storage/db';
import { memoryDriver } from '../client/src/storage/sqliteDriver';
import { Keychain } from '../client/src/storage/keychain';
import { FREE_ATTEMPTS, delayAfter, readLimiter, resetLimiter } from '../client/src/storage/attemptLimiter';

const MASTER = '135791';
const GHOST = '24680246';
const WRONG = '000000';

describe('PIN attempt limiter', () => {
  before(async () => {
    setSqlDriver(memoryDriver);
    Keychain.purgeMemory();
    memoryDriver.open('veil_vault_primary.db').delete();
    memoryDriver.open('veil_vault_decoy.db').delete();
    const p = generateMasterSeed();
    const g = generateMasterSeed();
    await provisionVaults({
      masterPin: MASTER,
      ghostPin: GHOST,
      primaryFingerprint: deriveMask(p, 0).fingerprint,
      ghostFingerprint: deriveMask(g, 1).fingerprint,
      primarySeed: p,
      ghostSeed: g,
    });
  });

  after(async () => {
    mock.restoreAll();
    await lockVault();
  });

  it('escalates delays without ever wiping', () => {
    for (let n = 1; n <= FREE_ATTEMPTS; n++) assert.equal(delayAfter(n), 0);
    const delays = [5, 6, 7, 8, 9, 50].map(delayAfter);
    assert.deepEqual(delays, [30_000, 60_000, 300_000, 900_000, 3_600_000, 3_600_000]);
  });

  it('allows free attempts, then holds further tries, even with the right PIN', async () => {
    await resetLimiter();
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      const r = await unlockWithPin(WRONG);
      assert.deepEqual(r, { ok: false, retryAfterMs: 0 });
    }
    const fifth = await unlockWithPin(WRONG);
    assert.equal(fifth.ok, false);
    assert.ok(!fifth.ok && fifth.retryAfterMs > 25_000);

    // While held, even the correct PIN is not evaluated.
    const held = await unlockWithPin(MASTER);
    assert.equal(held.ok, false);
    assert.equal((await readLimiter()).failures, FREE_ATTEMPTS + 1, 'held attempts are not counted');
  });

  it('lets the next attempt through once the delay passes, and resets on success', async () => {
    const realNow = Date.now.bind(Date);
    const clock = mock.method(Date, 'now', () => realNow() + 31_000);
    try {
      // The decoy PIN resets the shared counter exactly like the master PIN.
      const r = await unlockWithPin(GHOST);
      assert.equal(r.ok, true);
      assert.deepEqual(await readLimiter(), { failures: 0, lockedUntil: 0 });
    } finally {
      clock.mock.restore();
    }
    await lockVault();
  });

  it('keeps its state outside both vaults', async () => {
    await resetLimiter();
    await unlockWithPin(WRONG);
    assert.ok(await Keychain.getItem('veil.unlock.limiter.v1'), 'state lives in the keystore');
    for (const file of ['veil_vault_primary.db', 'veil_vault_decoy.db']) {
      const rows = memoryDriver.open(file).execute('SELECT value FROM meta WHERE key = ?', [
        'veil.unlock.limiter.v1',
      ]).rows;
      assert.equal(rows.length, 0);
    }
  });
});
