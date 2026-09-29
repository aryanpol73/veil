/**
 * ============================================================================
 *  VEIL — ADVERSARIAL & SECURITY PENETRATION TEST SUITE
 * ============================================================================
 *  Tests:
 *   1. Replay attack rejection in Double Ratchet (returns null)
 *   2. Ciphertext bit-flipping & Poly1305 authentication failure (returns null)
 *   3. Associated Data (AAD) identity/context binding tampering rejection (returns null)
 *   4. Forged SUB replay against fresh server challenge nonce
 *   5. Inbox hijacking denial (first-claim protection)
 *   6. Forged ACK rejection when not subscribed
 *   7. Malformed JSON & non-object WebSocket frame handling
 *   8. Oversized frame (> 8192 bytes) payload rejection
 *   9. Identity key replacement detection (CHANGED_IDENTITY security event)
 *  10. DoS skipped-keys threshold enforcement (returns null on excessive skip)
 * ============================================================================
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { startRelayServer, type RelayServerHandle } from '../server/src/relay';
import {
  generateMasterSeed,
  deriveMask,
  signInboxAuth,
  fromB64,
  toB64,
  randomBytes,
  x25519,
} from '../client/src/crypto/keys';
import {
  initAliceSession,
  initBobSession,
  ratchetEncryptMessage,
  ratchetDecryptMessage,
} from '../client/src/protocol/ratchet';
import { ContactManager } from '../client/src/protocol/contacts/ContactManager';
import { memoryDriver } from '../client/src/storage/sqliteDriver';
import { setSqlDriver, provisionVaults, unlockWithPin, lockVault } from '../client/src/storage/db';
import { Keychain } from '../client/src/storage/keychain';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (s: string) => encoder.encode(s);
const fromUtf8 = (b: Uint8Array) => decoder.decode(b);

describe('Veil Adversarial & Security Tests', () => {
  let server: RelayServerHandle;
  let serverUrl: string;

  before(async () => {
    setSqlDriver(memoryDriver);
    Keychain.purgeMemory();

    const primarySeed = generateMasterSeed();
    const ghostSeed = generateMasterSeed();
    await provisionVaults({
      masterPin: '111111',
      ghostPin: '222222',
      primaryFingerprint: 'PRIM ARY1 FP00 0000 0000',
      ghostFingerprint: 'GHOS T000 FP11 1111 1111',
      primarySeed,
      ghostSeed,
    });
    await unlockWithPin('111111');

    server = await startRelayServer(0, { busType: 'memory' });
    serverUrl = server.url;
  });

  after(async () => {
    await lockVault();
    await server.close();
  });

  async function openRawWs(): Promise<{
    ws: WebSocket;
    nonce: Uint8Array;
    nextFrame: () => Promise<any>;
    close: () => void;
  }> {
    const ws = new WebSocket(serverUrl);
    const queue: any[] = [];
    const waiters: ((frame: any) => void)[] = [];

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(data.toString('utf8'));
        if (waiters.length > 0) waiters.shift()!(frame);
        else queue.push(frame);
      } catch {
        if (waiters.length > 0) waiters.shift()!({ raw: data.toString('utf8') });
        else queue.push({ raw: data.toString('utf8') });
      }
    });

    const nextFrame = (): Promise<any> => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push(resolve));
    };

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (e) => reject(e));
    });

    const hello = await nextFrame();
    assert.equal(hello.t, 'HELLO');

    return {
      ws,
      nonce: fromB64(hello.nonce),
      nextFrame,
      close: () => ws.close(),
    };
  }

  it('1. Replay attack: Ratchet rejects duplicate delivery of same message', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const bobSk = new Uint8Array(bobKeygen.secretKey);
    const bobPk = new Uint8Array(bobKeygen.publicKey);

    const alice = initAliceSession(bobPk);
    const threadId = 'th_replay';
    const senderFp = 'FP_ALICE';

    const encrypted = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Confidential payload'),
      threadId,
      retention: 'persistent',
      senderFp,
    });

    const bob = initBobSession(bobSk, bobPk, fromB64(encrypted.header.dhPk));

    // Bob decrypts it first time -> OK
    const firstDelivery = ratchetDecryptMessage({
      state: bob,
      payload: encrypted,
      threadId,
      senderFp,
    });
    assert.ok(firstDelivery);
    assert.equal(fromUtf8(firstDelivery), 'Confidential payload');

    // Attacker intercepts and replays exact same envelope -> rejected (returns null)
    const replayed = ratchetDecryptMessage({
      state: bob,
      payload: encrypted,
      threadId,
      senderFp,
    });
    assert.equal(replayed, null);
  });

  it('2. Ciphertext tampering: Bit-flip causes AEAD decryption failure', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const bobSk = new Uint8Array(bobKeygen.secretKey);
    const bobPk = new Uint8Array(bobKeygen.publicKey);

    const alice = initAliceSession(bobPk);
    const threadId = 'th_tamper';
    const senderFp = 'FP_ALICE';

    const encrypted = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Wire tamper test'),
      threadId,
      retention: 'persistent',
      senderFp,
    });

    const bob = initBobSession(bobSk, bobPk, fromB64(encrypted.header.dhPk));

    // Flip bit in ciphertext
    const ctBytes = new Uint8Array(encrypted.ciphertext);
    ctBytes[0] ^= 0x01; // Tamper with first byte
    const tamperedPayload = {
      ...encrypted,
      ciphertext: ctBytes,
    };

    const res = ratchetDecryptMessage({
      state: bob,
      payload: tamperedPayload,
      threadId,
      senderFp,
    });
    assert.equal(res, null);
  });

  it('3. AAD Context binding tampering: Altering recipient/thread binding fails decryption', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const bobSk = new Uint8Array(bobKeygen.secretKey);
    const bobPk = new Uint8Array(bobKeygen.publicKey);

    const alice = initAliceSession(bobPk);
    const threadId = 'th_orig';
    const senderFp = 'FP_ALICE';

    const encrypted = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Context bound'),
      threadId,
      retention: 'persistent',
      senderFp,
    });

    const bob = initBobSession(bobSk, bobPk, fromB64(encrypted.header.dhPk));

    // Attacker attempts to change threadId context
    const res = ratchetDecryptMessage({
      state: bob,
      payload: encrypted,
      threadId: 'th_diverted',
      senderFp,
    });
    assert.equal(res, null);
  });

  it('4. Replayed SUB signature against new challenge nonce is DENIED', async () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    const inbox = 'inbox_stale_nonce_test';

    // Connection 1: authenticate legitimately
    const conn1 = await openRawWs();
    const auth1 = signInboxAuth(mask, inbox, conn1.nonce);
    conn1.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox,
        pk: auth1.signPk,
        sig: auth1.signature,
      })
    );
    const res1 = await conn1.nextFrame();
    assert.equal(res1.t, 'SUBBED');
    conn1.close();

    // Connection 2: Attacker replays signature from Connection 1
    const conn2 = await openRawWs();
    conn2.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox,
        pk: auth1.signPk,
        sig: auth1.signature, // Stale signature bound to conn1.nonce!
      })
    );
    const res2 = await conn2.nextFrame();
    assert.equal(res2.t, 'DENIED'); // Denied because conn2.nonce does not match!
    conn2.close();
  });

  it('5. Inbox hijacking: Adversary cannot claim an inbox already registered in epoch', async () => {
    const seedLegit = generateMasterSeed();
    const legit = deriveMask(seedLegit, 0);
    const seedEve = generateMasterSeed();
    const eve = deriveMask(seedEve, 0);

    const inbox = 'inbox_hijack_adversary_test';

    // Legit claims
    const c1 = await openRawWs();
    const auth1 = signInboxAuth(legit, inbox, c1.nonce);
    c1.ws.send(JSON.stringify({ t: 'SUB', inbox, pk: auth1.signPk, sig: auth1.signature }));
    const r1 = await c1.nextFrame();
    assert.equal(r1.t, 'SUBBED');

    // Eve attempts claim
    const c2 = await openRawWs();
    const authEve = signInboxAuth(eve, inbox, c2.nonce);
    c2.ws.send(JSON.stringify({ t: 'SUB', inbox, pk: authEve.signPk, sig: authEve.signature }));
    const r2 = await c2.nextFrame();
    assert.equal(r2.t, 'DENIED');

    c1.close();
    c2.close();
  });

  it('6. Forged ACK rejection: ACK sent without active subscription is dropped', async () => {
    const client = await openRawWs();

    // Client has not SUBBED to 'inbox_unsubbed'
    client.ws.send(
      JSON.stringify({
        t: 'ACK',
        inbox: 'inbox_unsubbed',
        ids: ['msg_random_1'],
      })
    );

    // Verify socket remains alive and unaffected
    client.ws.send(JSON.stringify({ t: 'PING' }));
    const pong = await client.nextFrame();
    assert.equal(pong.t, 'PONG');

    client.close();
  });

  it('7. Malformed JSON frames do not crash relay and are rejected gracefully', async () => {
    const client = await openRawWs();

    // Send broken JSON
    client.ws.send('{ "t": "SEND", "inbox": ');

    // Expect ERR frame
    const err = await client.nextFrame();
    assert.equal(err.t, 'ERR');
    assert.equal(err.code, 'PARSE');

    // Socket still responds to valid protocol commands
    client.ws.send(JSON.stringify({ t: 'PING' }));
    const pong = await client.nextFrame();
    assert.equal(pong.t, 'PONG');

    client.close();
  });

  it('8. Oversized frames exceeding maxFrameBytes are dropped / connection closed', async () => {
    const client = await openRawWs();

    // Create a 16KB payload (> 8192 maxFrameBytes)
    const bigPayload = 'A'.repeat(16384);

    let closed = false;
    client.ws.on('close', () => {
      closed = true;
    });

    client.ws.send(bigPayload);

    // Wait for ws close / drop
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(closed, true);
  });

  it('9. Identity key replacement: ContactManager detects changed key and flags CHANGED_IDENTITY', () => {
    const cm = new ContactManager();
    const seedBob1 = generateMasterSeed();
    const bob1 = deriveMask(seedBob1, 0);

    const seedBob2 = generateMasterSeed();
    const bob2 = deriveMask(seedBob2, 0); // Attacker or key replacement

    // Record original contact
    const contact1 = cm.saveContact({
      id: 'ct_bob',
      maskIndex: 0,
      alias: 'Bob',
      signPk: bob1.signPk,
      dhPk: bob1.dhPk,
      verified: true,
    });
    assert.equal(contact1.verificationState, 'VERIFIED');

    // Attacker tries to replace Bob's key under the same ID
    const contact2 = cm.saveContact({
      id: 'ct_bob',
      maskIndex: 0,
      alias: 'Bob',
      signPk: bob2.signPk, // Different key!
      dhPk: bob2.dhPk,
    });

    // ContactManager detects key substitution and warns
    assert.equal(contact2.verificationState, 'CHANGED_IDENTITY');
    assert.notDeepEqual(contact2.signPk, bob1.signPk);
  });

  it('10. DoS skipped-keys protection: Reject out-of-order counter gap exceeding limit', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const bobSk = new Uint8Array(bobKeygen.secretKey);
    const bobPk = new Uint8Array(bobKeygen.publicKey);

    const alice = initAliceSession(bobPk);
    const threadId = 'th_dos';
    const senderFp = 'FP_ALICE';

    const encrypted = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Valid'),
      threadId,
      retention: 'persistent',
      senderFp,
    });

    const bob = initBobSession(bobSk, bobPk, fromB64(encrypted.header.dhPk));

    // Attacker modifies counter to 50,000 to force generating thousands of keys
    const maliciousPayload = {
      ...encrypted,
      header: {
        ...encrypted.header,
        n: 50_000,
      },
    };

    const res = ratchetDecryptMessage({
      state: bob,
      payload: maliciousPayload,
      threadId,
      senderFp,
    });
    assert.equal(res, null);
  });
});
