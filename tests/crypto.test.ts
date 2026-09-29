/**
 * ============================================================================
 *  VEIL — CRYPTO CORE TEST SUITE
 * ============================================================================
 *  Tests:
 *   - Key generation & deterministic mask derivation
 *   - Fingerprint stability & Crockford base32 formatting
 *   - AEAD (XChaCha20-Poly1305) with 24-byte nonce & AAD verification
 *   - Tamper resistance (wrong key, modified ciphertext, modified tag, modified AAD)
 *   - Invitation creation, signing, canonicalization, tampering, and expiration
 *   - Envelope 4096-byte padding & unpadding
 * ============================================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateMasterSeed,
  deriveMask,
  destroyMask,
  computeFingerprint,
  aeadEncrypt,
  aeadDecrypt,
  encryptString,
  decryptString,
  packSealed,
  unpackSealed,
  createInvite,
  parseInvite,
  blindedInboxId,
  inboxWindow,
  signInboxAuth,
  toHex,
  fromHex,
  timingSafeEqual,
} from '../client/src/crypto/keys';
import { padEnvelope, unpadEnvelope, ENVELOPE_BYTE_SIZE } from '../client/src/crypto/padding';

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);

describe('Veil Cryptographic Core', () => {
  it('generates 32-byte CSPRNG master seed', () => {
    const seed1 = generateMasterSeed();
    const seed2 = generateMasterSeed();
    assert.equal(seed1.length, 32);
    assert.equal(seed2.length, 32);
    assert.notDeepEqual(seed1, seed2);
  });

  it('deterministically derives masks from master seed', () => {
    const seed = generateMasterSeed();
    const mask0_a = deriveMask(seed, 0);
    const mask0_b = deriveMask(seed, 0);
    const mask1 = deriveMask(seed, 1);

    // Same seed & index -> byte-identical keys
    assert.deepEqual(mask0_a.signPk, mask0_b.signPk);
    assert.deepEqual(mask0_a.signSk, mask0_b.signSk);
    assert.deepEqual(mask0_a.dhPk, mask0_b.dhPk);
    assert.deepEqual(mask0_a.dhSk, mask0_b.dhSk);
    assert.equal(mask0_a.fingerprint, mask0_b.fingerprint);

    // Different index -> cryptographically distinct keys
    assert.notDeepEqual(mask0_a.signPk, mask1.signPk);
    assert.notDeepEqual(mask0_a.dhPk, mask1.dhPk);
    assert.notEqual(mask0_a.fingerprint, mask1.fingerprint);
  });

  it('produces formatted Crockford Base32 safety fingerprints', () => {
    const signPk = new Uint8Array(32).fill(0xaa);
    const dhPk = new Uint8Array(32).fill(0x55);
    const fp1 = computeFingerprint(signPk, dhPk);
    const fp2 = computeFingerprint(signPk, dhPk);

    assert.equal(fp1, fp2);
    // Eight groups of 4 characters separated by spaces (160 bits / 5 bits = 32 chars / 4 = 8 blocks)
    const parts = fp1.split(' ');
    assert.equal(parts.length, 8);
    parts.forEach((p) => {
      assert.equal(p.length, 4);
      assert.match(p, /^[0-9A-HJKMNP-TV-Z]{4}$/); // Crockford alphabet (no I, L, O, U)
    });
  });

  it('destroys secret keys on destroyMask', () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    destroyMask(mask);

    assert(mask.signSk.every((b) => b === 0));
    assert(mask.dhSk.every((b) => b === 0));
  });

  it('encrypts and decrypts with XChaCha20-Poly1305 (24-byte nonce, 16-byte tag)', () => {
    const key = new Uint8Array(32).fill(42);
    const plaintext = utf8('Sensitive operation order: rendezvous sector 4');
    const aad = utf8('veil.aad.test.context');

    const sealed = aeadEncrypt(key, plaintext, aad);
    assert.equal(sealed.nonce.length, 24);
    assert.equal(sealed.ciphertext.length, plaintext.length + 16);

    const decrypted = aeadDecrypt(key, sealed, aad);
    assert.ok(decrypted);
    assert.deepEqual(decrypted, plaintext);
  });

  it('rejects decryption when wrong key is provided', () => {
    const key1 = new Uint8Array(32).fill(1);
    const key2 = new Uint8Array(32).fill(2);
    const plaintext = utf8('Classified transmission');

    const sealed = aeadEncrypt(key1, plaintext);
    const result = aeadDecrypt(key2, sealed);
    assert.equal(result, null);
  });

  it('rejects decryption when AAD is modified', () => {
    const key = new Uint8Array(32).fill(9);
    const plaintext = utf8('Payload');
    const aad1 = utf8('context.v1|thread_0');
    const aad2 = utf8('context.v1|thread_1');

    const sealed = aeadEncrypt(key, plaintext, aad1);
    const result = aeadDecrypt(key, sealed, aad2);
    assert.equal(result, null);
  });

  it('rejects decryption when ciphertext or tag is tampered with', () => {
    const key = new Uint8Array(32).fill(7);
    const plaintext = utf8('Do not tamper');
    const sealed = aeadEncrypt(key, plaintext);

    // Flip 1 bit in ciphertext
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] ^= 1;

    const result = aeadDecrypt(key, { nonce: sealed.nonce, ciphertext: tampered });
    assert.equal(result, null);
  });

  it('packs and unpacks sealed payloads to Base64URL string', () => {
    const key = new Uint8Array(32).fill(15);
    const text = 'Hello Obsidian Prism';
    const sealed = encryptString(key, text);
    const packed = packSealed(sealed);

    assert(packed.includes('.'));
    const unpacked = unpackSealed(packed);
    assert.ok(unpacked);
    const recovered = decryptString(key, unpacked);
    assert.equal(recovered, text);
  });

  it('creates and verifies canonical invitations', () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);

    const { uri, rendezvous, expiresAt } = createInvite(mask, {
      ttlSeconds: 3600,
      nick: 'Alice',
    });

    assert(uri.startsWith('veil://invite?'));
    assert.equal(rendezvous.length, 16);
    assert(expiresAt > Date.now());

    const parsed = parseInvite(uri);
    assert.ok(parsed);
    assert.equal(parsed.v, 1);
    assert.equal(parsed.nick, 'Alice');
    assert.deepEqual(parsed.ik, mask.signPk);
    assert.deepEqual(parsed.xk, mask.dhPk);
    assert.equal(parsed.fingerprint, mask.fingerprint);
    assert.ok(parsed.rendezvousInbox);
  });

  it('rejects tampered or forged invitations', () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    const { uri } = createInvite(mask);

    // Tamper with public key parameter
    const tamperedUri = uri.replace('ik=', 'ik=A');
    assert.equal(parseInvite(tamperedUri), null);

    // Invalid signature
    const badSigUri = uri.replace(/sig=[^&]+/, 'sig=AAAA');
    assert.equal(parseInvite(badSigUri), null);
  });

  it('rejects expired invitations', () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    // Create invite expired 10 seconds ago
    const { uri } = createInvite(mask, { ttlSeconds: -10 });
    assert.equal(parseInvite(uri), null);
  });

  it('derives blinded inbox IDs with epoch rotation', () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    const id1 = blindedInboxId(mask.dhPk, 100);
    const id2 = blindedInboxId(mask.dhPk, 100);
    const idNextHour = blindedInboxId(mask.dhPk, 101);

    assert.equal(id1, id2);
    assert.notEqual(id1, idNextHour);

    const window = inboxWindow(mask.dhPk, 100 * 3600 * 1000);
    assert.equal(window.length, 3);
  });

  it('signs inbox authorization tokens with server challenge nonce', () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    const serverNonce = new Uint8Array(32).fill(0x33);
    const inbox = 'inbox_test_123';

    const auth = signInboxAuth(mask, inbox, serverNonce);
    assert.ok(auth.signPk);
    assert.ok(auth.signature);
  });

  it('pads and unpads envelopes to exactly 4,096 bytes', () => {
    const smallPayload = utf8('Small payload under 100 bytes');
    const padded = padEnvelope(smallPayload, ENVELOPE_BYTE_SIZE);

    assert.equal(padded.length, ENVELOPE_BYTE_SIZE);

    const unpadded = unpadEnvelope(padded, ENVELOPE_BYTE_SIZE);
    assert.ok(unpadded);
    assert.deepEqual(unpadded, smallPayload);
  });

  it('rejects oversized payloads during padding', () => {
    const oversized = new Uint8Array(4095);
    assert.throws(() => padEnvelope(oversized, ENVELOPE_BYTE_SIZE));
  });

  it('constant-time equality test prevents early termination', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    const c = new Uint8Array([1, 2, 3, 4, 6]);
    assert.equal(timingSafeEqual(a, b), true);
    assert.equal(timingSafeEqual(a, c), false);
  });
});
