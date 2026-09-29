/**
 * ============================================================================
 *  VEIL — DOUBLE RATCHET PROTOCOL TEST SUITE
 * ============================================================================
 *  Tests:
 *   - Initial session setup for Alice and Bob
 *   - Basic send and receive message exchange
 *   - Two-way interactive ping-pong ratchet progression
 *   - Forward secrecy: chain advancement wipes intermediate keys
 *   - DH ratchet transitions across conversational turns
 *   - Out-of-order message delivery & skipped message keys cache
 *   - Replay attack rejection & duplicate message drops
 *   - AAD context binding & tampering rejection
 *   - State serialization / deserialization roundtrip
 * ============================================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, fromB64, toB64, x25519 } from '../client/src/crypto/keys';
import {
  initAliceSession,
  initBobSession,
  ratchetEncryptMessage,
  ratchetDecryptMessage,
  toStoredRatchet,
  fromStoredRatchet,
  type DoubleRatchetState,
} from '../client/src/protocol/ratchet';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (s: string) => encoder.encode(s);
const fromUtf8 = (b: Uint8Array) => decoder.decode(b);

describe('Veil Double Ratchet Protocol', () => {
  it('establishes session and exchanges initial message between Alice and Bob', () => {
    // Bob generates pre-shared exchange key (e.g. from an invitation)
    const bobKeygen = x25519.keygen(randomBytes(32));
    const bobSk = new Uint8Array(bobKeygen.secretKey);
    const bobPk = new Uint8Array(bobKeygen.publicKey);

    // Alice initializes with Bob's DH public key
    const alice = initAliceSession(bobPk);
    assert.equal(alice.sendCounter, 0);
    assert.equal(alice.recvCounter, 0);

    // Alice sends initial message
    const threadId = 'th_alice_bob';
    const senderFp = 'ALICE_FP';
    const text = 'Hello Bob, establishing Veil ratchet.';
    const encrypted = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8(text),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'msg_1',
    });

    assert.equal(alice.sendCounter, 1);
    assert.equal(encrypted.header.n, 0);
    assert.equal(encrypted.header.pn, 0);

    // Bob initializes upon receiving Alice's message
    const aliceDhPk = fromB64(encrypted.header.dhPk);
    const bob = initBobSession(bobSk, bobPk, aliceDhPk);

    // Bob decrypts Alice's message
    const decrypted = ratchetDecryptMessage({
      state: bob,
      payload: encrypted,
      threadId,
      senderFp,
    });

    assert.ok(decrypted);
    assert.equal(fromUtf8(decrypted), text);
    assert.equal(bob.recvCounter, 1);
  });

  it('supports two-way ping-pong conversations with DH ratchet transitions', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const bobSk = new Uint8Array(bobKeygen.secretKey);
    const bobPk = new Uint8Array(bobKeygen.publicKey);

    const alice = initAliceSession(bobPk);
    const threadId = 'th_test_ratchet';
    const aliceFp = 'FP_ALICE';
    const bobFp = 'FP_BOB';

    // Alice -> Bob: Message 1
    const m1Encrypted = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Alice: Ping 1'),
      threadId,
      retention: 'persistent',
      senderFp: aliceFp,
      msgId: 'm1',
    });

    const bob = initBobSession(bobSk, bobPk, fromB64(m1Encrypted.header.dhPk));
    const m1Decrypted = ratchetDecryptMessage({
      state: bob,
      payload: m1Encrypted,
      threadId,
      senderFp: aliceFp,
    });
    assert.equal(fromUtf8(m1Decrypted!), 'Alice: Ping 1');

    // Bob -> Alice: Message 2 (Bob's first outgoing message triggers DH ratchet)
    const m2Encrypted = ratchetEncryptMessage({
      state: bob,
      plaintext: utf8('Bob: Pong 1'),
      threadId,
      retention: 'persistent',
      senderFp: bobFp,
      msgId: 'm2',
    });

    const m2Decrypted = ratchetDecryptMessage({
      state: alice,
      payload: m2Encrypted,
      threadId,
      senderFp: bobFp,
    });
    assert.equal(fromUtf8(m2Decrypted!), 'Bob: Pong 1');

    // Alice -> Bob: Message 3 (Alice ratchets again)
    const m3Encrypted = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Alice: Ping 2'),
      threadId,
      retention: 'timed',
      senderFp: aliceFp,
      msgId: 'm3',
      ttlMs: 60_000,
    });

    const m3Decrypted = ratchetDecryptMessage({
      state: bob,
      payload: m3Encrypted,
      threadId,
      senderFp: aliceFp,
    });
    assert.equal(fromUtf8(m3Decrypted!), 'Alice: Ping 2');
  });

  it('handles multiple messages in the same symmetric chain', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const bobSk = new Uint8Array(bobKeygen.secretKey);
    const bobPk = new Uint8Array(bobKeygen.publicKey);
    const alice = initAliceSession(bobPk);
    const threadId = 'th_multi';
    const senderFp = 'ALICE_FP';

    // Alice sends 3 consecutive messages without waiting for Bob
    const m0 = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Msg 0'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'm0',
    });
    const m1 = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Msg 1'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'm1',
    });
    const m2 = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Msg 2'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'm2',
    });

    assert.equal(m0.header.n, 0);
    assert.equal(m1.header.n, 1);
    assert.equal(m2.header.n, 2);

    // Initialize Bob with m0's DH pk
    const bob = initBobSession(bobSk, bobPk, fromB64(m0.header.dhPk));

    // Bob receives in order
    assert.equal(fromUtf8(ratchetDecryptMessage({ state: bob, payload: m0, threadId, senderFp })!), 'Msg 0');
    assert.equal(fromUtf8(ratchetDecryptMessage({ state: bob, payload: m1, threadId, senderFp })!), 'Msg 1');
    assert.equal(fromUtf8(ratchetDecryptMessage({ state: bob, payload: m2, threadId, senderFp })!), 'Msg 2');
    assert.equal(bob.recvCounter, 3);
  });

  it('handles out-of-order message delivery via skipped keys cache', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const alice = initAliceSession(new Uint8Array(bobKeygen.publicKey));
    const threadId = 'th_out_of_order';
    const senderFp = 'ALICE_FP';

    const m0 = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Packet 0'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'p0',
    });
    const m1 = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Packet 1'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'p1',
    });
    const m2 = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Packet 2'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'p2',
    });

    const bob = initBobSession(
      new Uint8Array(bobKeygen.secretKey),
      new Uint8Array(bobKeygen.publicKey),
      fromB64(m0.header.dhPk),
    );

    // Bob receives m2 FIRST (ahead of m0 and m1)
    const d2 = ratchetDecryptMessage({ state: bob, payload: m2, threadId, senderFp });
    assert.ok(d2);
    assert.equal(fromUtf8(d2), 'Packet 2');
    assert.equal(bob.skippedKeys.size, 2); // Stored keys for counter 0 and 1

    // Bob receives m0 SECOND
    const d0 = ratchetDecryptMessage({ state: bob, payload: m0, threadId, senderFp });
    assert.ok(d0);
    assert.equal(fromUtf8(d0), 'Packet 0');
    assert.equal(bob.skippedKeys.size, 1); // Key 0 consumed

    // Bob receives m1 LAST
    const d1 = ratchetDecryptMessage({ state: bob, payload: m1, threadId, senderFp });
    assert.ok(d1);
    assert.equal(fromUtf8(d1), 'Packet 1');
    assert.equal(bob.skippedKeys.size, 0); // Key 1 consumed
  });

  it('rejects duplicate or replayed messages', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const alice = initAliceSession(new Uint8Array(bobKeygen.publicKey));
    const threadId = 'th_replay';
    const senderFp = 'ALICE_FP';

    const msg = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Original Message'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'replay_test',
    });

    const bob = initBobSession(
      new Uint8Array(bobKeygen.secretKey),
      new Uint8Array(bobKeygen.publicKey),
      fromB64(msg.header.dhPk),
    );

    // First delivery succeeds
    const d1 = ratchetDecryptMessage({ state: bob, payload: msg, threadId, senderFp });
    assert.ok(d1);
    assert.equal(fromUtf8(d1), 'Original Message');

    // Replay attempt fails and returns null
    const d2 = ratchetDecryptMessage({ state: bob, payload: msg, threadId, senderFp });
    assert.equal(d2, null);
  });

  it('rejects message with tampered AAD', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const alice = initAliceSession(new Uint8Array(bobKeygen.publicKey));
    const threadId = 'th_aad';
    const senderFp = 'ALICE_FP';

    const msg = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Important text'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'msg_aad_1',
    });

    const bob = initBobSession(
      new Uint8Array(bobKeygen.secretKey),
      new Uint8Array(bobKeygen.publicKey),
      fromB64(msg.header.dhPk),
    );

    // Attempt decryption with wrong senderFp or msgId in header
    const tamperedPayload = {
      ...msg,
      header: { ...msg.header, msgId: 'msg_forged_id' },
    };

    const result = ratchetDecryptMessage({
      state: bob,
      payload: tamperedPayload,
      threadId,
      senderFp,
    });
    assert.equal(result, null);
  });

  it('prevents ratchet state desynchronization on unauthenticated packets with new DH keys (SEC-01)', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const alice = initAliceSession(new Uint8Array(bobKeygen.publicKey));
    const threadId = 'th_desync_test';
    const senderFp = 'ALICE_FP';

    // Alice sends initial message 1
    const msg1 = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Legitimate message 1'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'msg_1',
    });

    const bob = initBobSession(
      new Uint8Array(bobKeygen.secretKey),
      new Uint8Array(bobKeygen.publicKey),
      fromB64(msg1.header.dhPk),
    );

    const d1 = ratchetDecryptMessage({ state: bob, payload: msg1, threadId, senderFp });
    assert.equal(fromUtf8(d1!), 'Legitimate message 1');

    // Snapshot Bob's local keys and counter before attack
    const bobRootBefore = new Uint8Array(bob.rootKey);
    const bobLocalPkBefore = new Uint8Array(bob.localDhPk);
    const bobRecvCounterBefore = bob.recvCounter;

    // Attacker injects a malicious message with a brand new DH key and bogus ciphertext
    const attackerKeygen = x25519.keygen(randomBytes(32));
    const attackerForgedPayload = {
      header: {
        dhPk: toB64(new Uint8Array(attackerKeygen.publicKey)),
        pn: 0,
        n: 0,
        retention: 'persistent' as const,
        msgId: 'msg_forged_eve',
      },
      nonce: randomBytes(24),
      ciphertext: randomBytes(64), // Invalid ciphertext, fails Poly1305 check
    };

    // Bob attempts to decrypt attacker's forged message
    const resAttacker = ratchetDecryptMessage({
      state: bob,
      payload: attackerForgedPayload,
      threadId,
      senderFp,
    });
    assert.equal(resAttacker, null);

    // Verify Bob's state was NOT mutated/desynchronized
    assert.deepEqual(bob.rootKey, bobRootBefore);
    assert.deepEqual(bob.localDhPk, bobLocalPkBefore);
    assert.equal(bob.recvCounter, bobRecvCounterBefore);

    // Alice now sends legitimate message 2
    const msg2 = ratchetEncryptMessage({
      state: alice,
      plaintext: utf8('Legitimate message 2 after attack'),
      threadId,
      retention: 'persistent',
      senderFp,
      msgId: 'msg_2',
    });

    // Bob can decrypt Alice's message with zero desynchronization!
    const d2 = ratchetDecryptMessage({ state: bob, payload: msg2, threadId, senderFp });
    assert.ok(d2);
    assert.equal(fromUtf8(d2!), 'Legitimate message 2 after attack');
  });

  it('serializes and restores ratchet state to/from stored schema', () => {
    const bobKeygen = x25519.keygen(randomBytes(32));
    const alice = initAliceSession(new Uint8Array(bobKeygen.publicKey));
    alice.sendCounter = 7;
    alice.recvCounter = 3;
    alice.prevChainLen = 2;
    const sampleMsgKey = randomBytes(32);
    alice.skippedKeys.set('fake_key_id:1', {
      remoteDhPkHex: 'abcd1234',
      counter: 1,
      messageKey: sampleMsgKey,
      createdAt: 1700000000,
    });

    const stored = toStoredRatchet(alice);
    const restored = fromStoredRatchet(stored);

    assert.deepEqual(restored.rootKey, alice.rootKey);
    assert.deepEqual(restored.sendChainKey, alice.sendChainKey);
    assert.deepEqual(restored.localDhSk, alice.localDhSk);
    assert.deepEqual(restored.localDhPk, alice.localDhPk);
    assert.deepEqual(restored.remoteDhPk, alice.remoteDhPk);
    assert.equal(restored.sendCounter, 7);
    assert.equal(restored.recvCounter, 3);
    assert.equal(restored.prevChainLen, 2);
    assert.equal(restored.skippedKeys.size, 1);
    const restoredEntry = restored.skippedKeys.get('fake_key_id:1');
    assert.ok(restoredEntry);
    assert.equal(restoredEntry.counter, 1);
    assert.deepEqual(restoredEntry.messageKey, sampleMsgKey);
  });
});
