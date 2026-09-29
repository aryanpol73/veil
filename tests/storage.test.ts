/**
 * ============================================================================
 *  VEIL — DUAL-PARTITION VAULT & STORAGE TEST SUITE
 * ============================================================================
 *  Tests:
 *   - Provisioning primary & decoy partitions simultaneously
 *   - Master PIN unlocking primary partition (Mask 0)
 *   - Ghost PIN unlocking decoy partition (Mask 1)
 *   - Incorrect PIN rejection (fails canary decryption)
 *   - Vault locking and RAM purge
 *   - RamVault View-Once lifecycle (RAM-only, immediate burn on release)
 *   - Timed message read arming and TTL sweep deletion
 *   - Panic wipe re-provisioning
 * ============================================================================
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  provisionVaults,
  unlockWithPin,
  lockVault,
  getDb,
  activeMaskIndex,
  isProvisioned,
  insertMessage,
  listMessages,
  markReadAndArmTtl,
  sweepExpired,
  loadSealedMasterSeed,
  RamVault,
  setSqlDriver,
  saveRatchet,
  loadRatchet,
} from '../client/src/storage/db';
import { memoryDriver } from '../client/src/storage/sqliteDriver';
import { Keychain } from '../client/src/storage/keychain';
import { generateMasterSeed, randomBytes, unpackSealed, toHex } from '../client/src/crypto/keys';
import { ContactManager } from '../client/src/protocol/contacts/ContactManager';

describe('Veil Dual-Partition Vault & Storage', () => {
  const MASTER_PIN = '123456';
  const GHOST_PIN = '654321';
  const WRONG_PIN = '000000';

  before(async () => {
    setSqlDriver(memoryDriver);
    Keychain.purgeMemory();
    RamVault.purgeAll();
    memoryDriver.open('veil_vault_primary.db').delete();
    memoryDriver.open('veil_vault_decoy.db').delete();
  });

  afterEach(async () => {
    await lockVault();
    RamVault.purgeAll();
  });

  it('provisions both vaults and verifies unprovisioned vs provisioned status', async () => {
    assert.equal(isProvisioned(), false);

    const primarySeed = generateMasterSeed();
    const ghostSeed = generateMasterSeed();

    await provisionVaults({
      masterPin: MASTER_PIN,
      ghostPin: GHOST_PIN,
      primaryFingerprint: 'PRIM ARY1 FP00 0000 0000',
      ghostFingerprint: 'GHOS T000 FP11 1111 1111',
      primarySeed,
      ghostSeed,
    });

    assert.equal(isProvisioned(), true);
  });

  it('unlocks primary vault with Master PIN and loads primary identity', async () => {
    const res = await unlockWithPin(MASTER_PIN);
    assert.equal(res.ok, true);
    assert.equal(activeMaskIndex(), 0); // Primary partition

    const seed = loadSealedMasterSeed();
    assert.ok(seed);
    assert.equal(seed.length, 32);
  });

  it('unlocks decoy vault with Ghost PIN and loads ghost identity', async () => {
    const res = await unlockWithPin(GHOST_PIN);
    assert.equal(res.ok, true);
    assert.equal(activeMaskIndex(), 1); // Ghost partition

    const seed = loadSealedMasterSeed();
    assert.ok(seed);
    assert.equal(seed.length, 32);

    // Verify decoy has seeded conversations
    const messages = listMessages('dt_0');
    assert(messages.length > 0);
  });

  it('rejects invalid PIN and leaves vault securely locked', async () => {
    const res = await unlockWithPin(WRONG_PIN);
    assert.equal(res.ok, false);
    assert.throws(() => getDb(), /vault is locked/);
  });

  it('isolates View-Once messages strictly to RAM and burns upon release', async () => {
    const res = await unlockWithPin(MASTER_PIN);
    assert.equal(res.ok, true);

    const threadId = 'th_ram_test';
    const text = 'Ephemeral confidential token: 4981-D9F2';

    const msg = insertMessage({
      id: 'vo_1',
      threadId,
      direction: 'in',
      retention: 'viewOnce',
      body: text,
    });

    assert.equal(msg.retention, 'viewOnce');
    assert.equal(RamVault.size, 1);

    // Verify View-Once is NOT persisted in SQLite messages table
    const db = getDb();
    const rows = db.execute<any>('SELECT * FROM messages WHERE id = ?', ['vo_1']).rows;
    assert.equal(rows.length, 0);

    // Visible in listMessages
    const listed = listMessages(threadId);
    assert.equal(listed.some((m) => m.id === 'vo_1'), true);

    // Burn message
    RamVault.burn('vo_1');
    assert.equal(RamVault.size, 0);
    assert.equal(RamVault.get('vo_1'), undefined);

    // No longer visible
    const listedAfter = listMessages(threadId);
    assert.equal(listedAfter.some((m) => m.id === 'vo_1'), false);
  });

  it('arms TTL countdown on read and sweeps expired timed messages', async () => {
    const res = await unlockWithPin(MASTER_PIN);
    assert.equal(res.ok, true);

    const threadId = 'th_timed_test';

    const msg = insertMessage({
      id: 'timed_1',
      threadId,
      direction: 'in',
      retention: 'timed',
      body: 'Destructs in 50ms',
      ttlMs: 50,
    });

    // Before read, expires_at is not set
    assert.equal(msg.read_at, null);

    // User reads message
    markReadAndArmTtl('timed_1');
    const db = getDb();
    const rowBefore = db.execute<any>('SELECT * FROM messages WHERE id = ?', ['timed_1']).rows[0];
    assert.ok(rowBefore.read_at);
    assert.ok(rowBefore.expires_at);

    // Wait for TTL expiration
    await new Promise((r) => setTimeout(r, 70));

    // Sweep expired
    const swept = sweepExpired();
    assert(swept >= 1);

    // Record has been deleted
    const rowAfter = db.execute<any>('SELECT * FROM messages WHERE id = ?', ['timed_1']).rows;
    assert.equal(rowAfter.length, 0);
  });

  it('purges all RAM View-Once messages when vault is locked', async () => {
    const res = await unlockWithPin(MASTER_PIN);
    assert.equal(res.ok, true);

    insertMessage({
      id: 'vo_burn_on_lock',
      threadId: 'th_test',
      direction: 'in',
      retention: 'viewOnce',
      body: 'Classified brief',
    });

    assert.equal(RamVault.size, 1);

    // Locking vault purges RamVault
    await lockVault();
    assert.equal(RamVault.size, 0);
  });

  it('encrypts contact records at rest with AEAD and supports blind-index lookup (SEC-02, SEC-03)', async () => {
    const res = await unlockWithPin(MASTER_PIN);
    assert.equal(res.ok, true);

    const cm = new ContactManager();
    const signPk = randomBytes(32);
    const dhPk = randomBytes(32);

    const contact = cm.saveContact({
      id: 'ct_sec02_test',
      maskIndex: 0,
      alias: 'Whistleblower Alpha',
      signPk,
      dhPk,
      verified: true,
    });

    assert.equal(contact.alias, 'Whistleblower Alpha');

    // Inspect RAW database row directly to verify zero plaintext leakage
    const db = getDb();
    const rawRows = db.execute<any>('SELECT * FROM contacts WHERE id = ?', ['ct_sec02_test']).rows;
    assert.equal(rawRows.length, 1);
    const raw = rawRows[0];

    // 1. Plaintext alias must NEVER appear in the stored row
    assert.notEqual(raw.alias, 'Whistleblower Alpha');
    assert.ok(unpackSealed(raw.alias), 'alias must be packed sealed AEAD payload');

    // 2. Plaintext fingerprint must NEVER appear in the stored row
    assert.notEqual(raw.fingerprint, contact.fingerprint);
    assert.ok(unpackSealed(raw.fingerprint), 'fingerprint must be packed sealed AEAD payload');

    // 3. Public keys must be sealed AEAD payloads
    assert.ok(unpackSealed(raw.sign_pk), 'sign_pk must be packed sealed AEAD payload');
    assert.ok(unpackSealed(raw.dh_pk), 'dh_pk must be packed sealed AEAD payload');

    // 4. Blind index tag exists and differs from plaintext fingerprint
    assert.ok(raw.fp_tag);
    assert.notEqual(raw.fp_tag, contact.fingerprint);

    // 5. Lookups via ContactManager decrypt transparently
    const retrievedById = cm.getContact('ct_sec02_test');
    assert.ok(retrievedById);
    assert.equal(retrievedById.alias, 'Whistleblower Alpha');
    assert.deepEqual(retrievedById.signPk, signPk);
    assert.deepEqual(retrievedById.dhPk, dhPk);
    assert.equal(retrievedById.fingerprint, contact.fingerprint);

    // 6. Fast lookup by fingerprint via blind index
    const retrievedByFp = cm.getContactByFingerprint(contact.fingerprint);
    assert.ok(retrievedByFp);
    assert.equal(retrievedByFp.id, 'ct_sec02_test');
    assert.equal(retrievedByFp.alias, 'Whistleblower Alpha');
  });

  it('persists and restores skipped ratchet keys and seals DH public keys at rest (SEC-05)', async () => {
    const res = await unlockWithPin(MASTER_PIN);
    assert.equal(res.ok, true);

    const threadId = 'th_skipped_keys_test';
    const rootKey = randomBytes(32);
    const sendDhSk = randomBytes(32);
    const sendDhPk = randomBytes(32);
    const recvDhPk = randomBytes(32);
    const skippedMsgKey = randomBytes(32);
    const remoteHex = toHex(recvDhPk);

    saveRatchet(threadId, {
      rootKey,
      sendChainKey: randomBytes(32),
      recvChainKey: randomBytes(32),
      sendDhSk,
      sendDhPk,
      recvDhPk,
      sendCounter: 2,
      recvCounter: 5,
      prevChainLen: 1,
      skippedKeys: [
        {
          id: `${remoteHex}:3`,
          remoteDhPkHex: remoteHex,
          counter: 3,
          messageKey: skippedMsgKey,
          createdAt: 1700000000000,
        },
      ],
    });

    // Verify raw row has sealed public keys and sealed skipped keys
    const db = getDb();
    const rawRow = db.execute<any>('SELECT * FROM ratchets WHERE thread_id = ?', [threadId]).rows[0];
    assert.ok(rawRow);
    assert.ok(unpackSealed(rawRow.send_dh_pk), 'send_dh_pk must be sealed AEAD');
    assert.ok(unpackSealed(rawRow.recv_dh_pk), 'recv_dh_pk must be sealed AEAD');
    assert.ok(unpackSealed(rawRow.skipped_keys), 'skipped_keys must be sealed AEAD');

    // Restore and verify state
    const loaded = loadRatchet(threadId);
    assert.ok(loaded);
    assert.deepEqual(loaded.sendDhPk, sendDhPk);
    assert.deepEqual(loaded.recvDhPk, recvDhPk);
    assert.ok(loaded.skippedKeys);
    assert.equal(loaded.skippedKeys.length, 1);
    assert.equal(loaded.skippedKeys[0].id, `${remoteHex}:3`);
    assert.equal(loaded.skippedKeys[0].counter, 3);
    assert.deepEqual(loaded.skippedKeys[0].messageKey, skippedMsgKey);
    assert.equal(loaded.skippedKeys[0].createdAt, 1700000000000);
  });
});
