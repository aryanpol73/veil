/**
 * ============================================================================
 *  VEIL — PRODUCTION PIPELINE TESTS (wire v2)
 * ============================================================================
 *  Drives the real client classes (SessionController, MessageService,
 *  RatchetManager, RelayClient, ContactManager) against a real relay on
 *  localhost and a real SQLite database. The older e2e suite builds frames
 *  by hand and never exercises these classes (audit §5).
 *
 *  One process has one vault slot, so the two parties take turns on the same
 *  "device": Alice lives in the primary vault, Bob in the decoy vault. Taking
 *  turns also means every message crosses the relay while its recipient is
 *  offline, which is the hard case for delivery.
 * ============================================================================
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startRelayServer, type RelayServerHandle } from '../server/src/relay';
import {
  deriveMask,
  fromB64,
  generateMasterSeed,
  parseInvite,
  signInboxAuth,
  toB64,
  type MaskIdentity,
} from '../client/src/crypto/keys';
import {
  getDb,
  isVaultOpen,
  listMessages,
  provisionVaults,
  RamVault,
  setSqlDriver,
  unlockWithPin,
  type StoredMessage,
} from '../client/src/storage/db';
import { Keychain } from '../client/src/storage/keychain';
import { contactManager } from '../client/src/protocol/contacts/ContactManager';
import { createIntro, encodeInner, sealIntro } from '../client/src/protocol/intro';
import {
  introKeyFromRoot,
  rendezvousHeaderKey,
  rendezvousInboxId,
} from '../client/src/protocol/pairing';
import { initAliceSession, ratchetEncryptMessage } from '../client/src/protocol/ratchet';
import { sealEnvelope, toWireHeader } from '../client/src/transport/SealedEnvelope';
import { relayClient } from '../client/src/transport/RelayClient';
import {
  MAX_MESSAGE_BYTES,
  MessageTooLargeError,
  messageService,
  threadIdFor,
} from '../client/src/messaging/MessageService';
import { identityManager } from '../client/src/identity/IdentityManager';
import { beginSession, endSession } from '../client/src/session/SessionController';
import type { Contact } from '../client/src/types/models';
import { createNodeSqliteDriver, type NodeSqliteDriver } from './helpers/nodeSqliteDriver';

const ALICE_PIN = '111111';
const BOB_PIN = '22222222'; // 8 digits: a length the old unlock screen could not enter

/** Every frame the production RelayClient writes to the relay. */
const clientFrames: string[] = [];
const NativeWebSocket = globalThis.WebSocket;
const originalSend = NativeWebSocket.prototype.send;
NativeWebSocket.prototype.send = function (this: WebSocket, data: any) {
  if (typeof data === 'string') clientFrames.push(data);
  return originalSend.call(this, data);
};

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openAs(pin: string): Promise<MaskIdentity> {
  await endSession();
  const res = await unlockWithPin(pin);
  assert.equal(res.ok, true, 'unlock should succeed');
  const mask = beginSession();
  assert.ok(mask, 'session should start');
  await waitFor(() => relayClient.currentStatus === 'connected', 'relay connection');
  return mask!;
}

/** All inbound+outbound messages in every thread of the open vault. */
function allMessages(): StoredMessage[] {
  const threads = getDb().execute<{ id: string }>('SELECT id FROM threads').rows;
  return threads.flatMap((t) => listMessages(t.id));
}

function contactFor(fingerprint: string): Contact | null {
  return contactManager.getContactByFingerprint(fingerprint);
}

/** A raw relay connection, as any internet client could open. */
async function rawClient(url: string) {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const hello = await waitFor(() => frames.find((f) => f.t === 'HELLO'), 'HELLO');
  return {
    nonce: fromB64(hello.nonce),
    send: (obj: unknown) => ws.send(JSON.stringify(obj)),
    reply: () => waitFor(() => frames.find((f) => f.t !== 'HELLO'), 'relay reply'),
    close: () => ws.close(),
  };
}

/** A first-contact message from `sender` to Bob through invite token `rz`. */
function forgeFirstContact(
  sender: MaskIdentity,
  bob: { signPk: Uint8Array; dhPk: Uint8Array; fingerprint: string },
  rz: Uint8Array,
  body: string,
): { inbox: string; env: string } {
  const state = initAliceSession(bob.dhPk);
  const introKey = introKeyFromRoot(state.rootKey);
  const enc = ratchetEncryptMessage({
    state,
    plaintext: encodeInner({ body }),
    threadId: [sender.fingerprint, bob.fingerprint].sort().join(':'),
    retention: 'persistent',
    senderFp: sender.fingerprint,
    msgId: `m_${toB64(new Uint8Array(8))}`,
  });
  const header = toWireHeader(enc.header);
  const intro = sealIntro(createIntro(sender, state.localDhPk, bob.signPk, bob.dhPk), introKey, header.dhPk);
  const inbox = rendezvousInboxId(rz);
  return {
    inbox,
    env: sealEnvelope(rendezvousHeaderKey(rz), inbox, {
      header,
      intro,
      nonce: enc.nonce,
      ciphertext: enc.ciphertext,
    }),
  };
}

describe('Veil production pipeline (real classes, real relay, real SQLite)', () => {
  let server: RelayServerHandle;
  let driver: NodeSqliteDriver;
  let alice: MaskIdentity;
  let bob: { signPk: Uint8Array; dhPk: Uint8Array; fingerprint: string };
  let inviteRz: Uint8Array;
  let aliceThreadOnAlice = '';
  const secretsSeen: string[] = [];

  before(async () => {
    driver = createNodeSqliteDriver();
    setSqlDriver(driver);
    Keychain.purgeMemory();
    RamVault.purgeAll();

    server = await startRelayServer(0, { busType: 'memory' });
    relayClient.setUrl(server.url);

    const primarySeed = generateMasterSeed();
    const ghostSeed = generateMasterSeed();
    await provisionVaults({
      masterPin: ALICE_PIN,
      ghostPin: BOB_PIN,
      primaryFingerprint: deriveMask(primarySeed, 0).fingerprint,
      ghostFingerprint: deriveMask(ghostSeed, 1).fingerprint,
      primarySeed,
      ghostSeed,
    });
  });

  after(async () => {
    mock.restoreAll();
    NativeWebSocket.prototype.send = originalSend;
    await endSession();
    await server.close();
    driver.dispose();
  });

  it('pairs via invite and delivers the first message to an offline recipient', async () => {
    const bobMask = await openAs(BOB_PIN);
    bob = {
      signPk: new Uint8Array(bobMask.signPk),
      dhPk: new Uint8Array(bobMask.dhPk),
      fingerprint: bobMask.fingerprint,
    };
    const { uri } = messageService.createInvite();
    // Let the rendezvous SUB reach the relay so Bob's claim is in place.
    await sleep(200);
    await endSession();

    alice = await openAs(ALICE_PIN);
    const parsed = parseInvite(uri);
    assert.ok(parsed);
    inviteRz = parsed!.rz;
    const { contact, thread } = contactManager.createFromInvite(parsed!, alice.index);
    aliceThreadOnAlice = thread.id;

    const sent = await messageService.sendMessage({
      threadId: thread.id,
      contact,
      body: 'hello bob',
      retention: 'persistent',
      senderFp: alice.fingerprint,
    });
    assert.ok(sent.delivered_at, 'relay should accept the envelope');
    await endSession();

    await openAs(BOB_PIN);
    const aliceOnBob = await waitFor(() => contactFor(alice.fingerprint), 'Bob learns Alice from her intro');
    assert.equal(aliceOnBob.verificationState, 'UNVERIFIED');
    assert.ok(aliceOnBob.pairSecret, 'Bob derives the pair secret');
    const inbound = await waitFor(
      () => listMessages(threadIdFor(aliceOnBob)).filter((m) => m.direction === 'in'),
      'first message stored',
    );
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].body, 'hello bob');
    assert.notEqual(inbound[0].id, sent.id, 'inbound local IDs never come from the wire');
  });

  it('routes replies over pair inboxes and continues both ways', async () => {
    const aliceOnBob = contactFor(alice.fingerprint)!;
    await messageService.sendMessage({
      threadId: threadIdFor(aliceOnBob),
      contact: aliceOnBob,
      body: 'hi alice',
      retention: 'persistent',
      senderFp: bob.fingerprint,
    });
    await endSession();

    await openAs(ALICE_PIN);
    const reply = await waitFor(
      () => listMessages(aliceThreadOnAlice).find((m) => m.direction === 'in'),
      'Alice receives the reply',
    );
    assert.equal(reply.body, 'hi alice');

    await messageService.sendMessage({
      threadId: aliceThreadOnAlice,
      contact: contactFor(bob.fingerprint)!,
      body: 'second from alice',
      retention: 'timed',
      ttlMs: 60_000,
      senderFp: alice.fingerprint,
    });
    await endSession();

    await openAs(BOB_PIN);
    const thread = threadIdFor(contactFor(alice.fingerprint)!);
    await waitFor(
      () => listMessages(thread).filter((m) => m.direction === 'in').length === 2,
      'Bob receives the second message',
    );
    const second = listMessages(thread).find((m) => m.body === 'second from alice')!;
    assert.equal(second.retention, 'timed');
    assert.equal(second.ttl_ms, 60_000);
  });

  it('ACKs only committed messages, so nothing is redelivered after reconnect', async () => {
    const before = allMessages().length;
    await endSession();
    await openAs(BOB_PIN);
    await sleep(400);
    assert.equal(allMessages().length, before);
  });

  it('delivers mail sent many hours ago to a recipient offline since (A-08)', async () => {
    await endSession();
    await openAs(ALICE_PIN);

    // Sent 20 hours ago: several pair-inbox epochs have rolled since.
    const realNow = Date.now.bind(Date);
    const clock = mock.method(Date, 'now', () => realNow() - 20 * 3_600_000);
    try {
      await messageService.sendMessage({
        threadId: aliceThreadOnAlice,
        contact: contactFor(bob.fingerprint)!,
        body: 'sent while you were away',
        retention: 'persistent',
        senderFp: alice.fingerprint,
      });
    } finally {
      clock.mock.restore();
    }
    await endSession();

    await openAs(BOB_PIN);
    await waitFor(
      () => allMessages().find((m) => m.body === 'sent while you were away'),
      'catch-up window claims the old inbox',
    );
  });

  it('admits only one initiator per invite (single use)', async () => {
    await endSession();
    const mallory = deriveMask(generateMasterSeed(), 0);
    const { inbox, env } = forgeFirstContact(mallory, bob, inviteRz, 'evil');
    const c = await rawClient(server.url);
    c.send({ t: 'SEND', inbox, env });
    assert.equal((await c.reply()).t, 'ACCEPTED');
    c.close();

    await openAs(BOB_PIN);
    await sleep(400);
    assert.equal(allMessages().some((m) => m.body === 'evil'), false);
    assert.equal(contactFor(mallory.fingerprint), null);
  });

  it('lets invite holders write to the rendezvous inbox but not claim it (A-09)', async () => {
    // Bob is online and holds the claim; anyone else is denied.
    const c = await rawClient(server.url);
    const squatter = deriveMask(generateMasterSeed(), 0);
    const inbox = rendezvousInboxId(inviteRz);
    const auth = signInboxAuth(squatter, inbox, c.nonce);
    c.send({ t: 'SUB', inbox, pk: auth.signPk, sig: auth.signature });
    assert.equal((await c.reply()).t, 'DENIED');
    c.close();
  });

  it('never puts identity keys, fingerprints, headers or plaintext on the wire (A-01, A-02)', async () => {
    const aliceOnBob = contactFor(alice.fingerprint)!;
    secretsSeen.push(
      toB64(alice.signPk),
      toB64(alice.dhPk),
      toB64(bob.signPk),
      toB64(bob.dhPk),
      alice.fingerprint,
      bob.fingerprint,
      alice.fingerprint.replace(/ /g, ''),
      bob.fingerprint.replace(/ /g, ''),
      toB64(aliceOnBob.pairSecret!),
    );
    const plaintexts = ['hello bob', 'hi alice', 'second from alice', 'sent while you were away'];

    assert.ok(clientFrames.length > 0);
    for (const frame of clientFrames) {
      for (const s of [...secretsSeen, ...plaintexts]) {
        assert.equal(frame.includes(s), false, `frame leaks ${s.slice(0, 12)}…`);
      }
      const f = JSON.parse(frame);
      if (f.t !== 'SEND') continue;
      const raw = Buffer.from(f.env, 'base64');
      assert.equal(raw.length, 4096);
      assert.equal(raw[0], 0x02, 'sealed v2 envelope');
      const text = raw.toString('latin1');
      for (const marker of ['"h"', '"dhPk"', '"retention"', '"msgId"', 'persistent', 'timed']) {
        assert.equal(text.includes(marker), false, `envelope exposes ${marker}`);
      }
    }
  });

  it('refuses oversized messages before storing or sending anything', async () => {
    const aliceOnBob = contactFor(alice.fingerprint)!;
    const before = allMessages().length;
    await assert.rejects(
      messageService.sendMessage({
        threadId: threadIdFor(aliceOnBob),
        contact: aliceOnBob,
        body: 'x'.repeat(MAX_MESSAGE_BYTES + 1),
        retention: 'persistent',
        senderFp: bob.fingerprint,
      }),
      MessageTooLargeError,
    );
    assert.equal(allMessages().length, before);
  });

  it('accepts the largest allowed message, with multi-byte text', async () => {
    const aliceOnBob = contactFor(alice.fingerprint)!;
    const body = 'é'.repeat(MAX_MESSAGE_BYTES / 2); // 2 bytes each
    const sent = await messageService.sendMessage({
      threadId: threadIdFor(aliceOnBob),
      contact: aliceOnBob,
      body,
      retention: 'persistent',
      senderFp: bob.fingerprint,
    });
    assert.ok(sent.delivered_at);
  });

  it('flags a re-imported identity with a new exchange key as CHANGED_IDENTITY (A-11)', async () => {
    await endSession();
    const aliceMask = await openAs(ALICE_PIN);
    const bobOnAlice = contactFor(bob.fingerprint)!;
    const { contact } = contactManager.createFromInvite(
      {
        v: 1,
        ik: bobOnAlice.signPk,
        xk: deriveMask(generateMasterSeed(), 1).dhPk,
        rz: new Uint8Array(16),
        exp: Math.floor(Date.now() / 1000) + 60,
        fingerprint: '',
        rendezvousInbox: '',
      },
      aliceMask.index,
    );
    assert.equal(contact.id, bobOnAlice.id, 'same identity key reuses the contact');
    const stored = contactManager.getContact(contact.id)!;
    assert.equal(stored.verificationState, 'CHANGED_IDENTITY');
    assert.equal(stored.pairSecret, null, 'the old session is dropped');
  });

  it('tears down every component on lock (A-10)', async () => {
    await endSession();
    assert.equal(isVaultOpen(), false);
    assert.equal(relayClient.currentStatus, 'disconnected');
    assert.equal(identityManager.getActiveMask(), null);
    assert.equal(RamVault.size, 0);
  });
});
