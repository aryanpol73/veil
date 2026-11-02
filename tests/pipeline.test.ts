/**
 * ============================================================================
 *  VEIL — PRODUCTION PIPELINE TESTS
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
  blindedInboxId,
  createInvite,
  deriveMask,
  generateMasterSeed,
  parseInvite,
  timingSafeEqual,
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
import { createIntro, encodeInner } from '../client/src/protocol/intro';
import { initAliceSession, ratchetEncryptMessage } from '../client/src/protocol/ratchet';
import { EnvelopeCodec } from '../client/src/transport/EnvelopeCodec';
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

/** Sends a raw, unauthenticated SEND frame, as any internet client could. */
async function rawSend(url: string, inbox: string, env: string): Promise<string> {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.send(JSON.stringify({ t: 'SEND', inbox, env }));
  const reply = await waitFor(() => frames.find((f) => f.t !== 'HELLO'), 'relay reply');
  ws.close();
  return reply.t;
}

describe('Veil production pipeline (real classes, real relay, real SQLite)', () => {
  let server: RelayServerHandle;
  let driver: NodeSqliteDriver;
  let aliceFp = '';
  let bobFp = '';
  let bobPks: { signPk: Uint8Array; dhPk: Uint8Array };
  let aliceThreadOnAlice = '';

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
    await endSession();
    await server.close();
    driver.dispose();
  });

  it('pairs via invite and delivers the first message to an offline recipient', async () => {
    const bob = await openAs(BOB_PIN);
    bobFp = bob.fingerprint;
    bobPks = { signPk: new Uint8Array(bob.signPk), dhPk: new Uint8Array(bob.dhPk) };
    const { uri } = createInvite(bob);
    await endSession();

    const alice = await openAs(ALICE_PIN);
    aliceFp = alice.fingerprint;
    const parsed = parseInvite(uri);
    assert.ok(parsed);
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
    assert.equal(sent.id.startsWith('m_'), true, 'outbound IDs come from the CSPRNG');
    await endSession();

    await openAs(BOB_PIN);
    const aliceOnBob = await waitFor(() => contactFor(aliceFp), 'Bob learns Alice from her intro');
    // Bob's contact carries Alice's REAL identity keys, not her session key.
    assert.equal(aliceOnBob.fingerprint, aliceFp);
    assert.equal(aliceOnBob.verificationState, 'UNVERIFIED');
    const inbound = await waitFor(
      () => listMessages(threadIdFor(aliceOnBob)).filter((m) => m.direction === 'in'),
      'first message stored',
    );
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].body, 'hello bob');
    assert.notEqual(inbound[0].id, sent.id, 'inbound local IDs never come from the wire');
  });

  it('routes replies to the initiator and continues both ways', async () => {
    const aliceOnBob = contactFor(aliceFp)!;
    await messageService.sendMessage({
      threadId: threadIdFor(aliceOnBob),
      contact: aliceOnBob,
      body: 'hi alice',
      retention: 'persistent',
      senderFp: bobFp,
    });
    await endSession();

    await openAs(ALICE_PIN);
    const reply = await waitFor(
      () => listMessages(aliceThreadOnAlice).find((m) => m.direction === 'in'),
      'Alice receives the reply',
    );
    assert.equal(reply.body, 'hi alice');

    const bobOnAlice = contactFor(bobFp)!;
    await messageService.sendMessage({
      threadId: aliceThreadOnAlice,
      contact: bobOnAlice,
      body: 'second from alice',
      retention: 'persistent',
      senderFp: aliceFp,
    });
    await endSession();

    await openAs(BOB_PIN);
    const thread = threadIdFor(contactFor(aliceFp)!);
    await waitFor(
      () => listMessages(thread).filter((m) => m.direction === 'in').length === 2,
      'Bob receives the second message',
    );
    assert.equal(
      allMessages().filter((m) => m.body === 'hello bob' || m.body === 'second from alice').length,
      2,
      'no duplicate contact or thread was created',
    );
  });

  it('ACKs only committed messages, so nothing is redelivered after reconnect', async () => {
    const before = allMessages().length;
    await endSession();
    await openAs(BOB_PIN);
    await sleep(400);
    assert.equal(allMessages().length, before);
  });

  it('delivers mail sent hours ago to a recipient who was offline since (A-08)', async () => {
    await endSession();
    await openAs(ALICE_PIN);
    const bobOnAlice = contactFor(bobFp)!;

    // Send as if it were five hours ago: the envelope lands in an inbox for an
    // epoch that is long past by the time Bob comes back.
    const realNow = Date.now.bind(Date);
    const clock = mock.method(Date, 'now', () => realNow() - 5 * 3_600_000);
    try {
      await messageService.sendMessage({
        threadId: aliceThreadOnAlice,
        contact: bobOnAlice,
        body: 'sent while you were away',
        retention: 'persistent',
        senderFp: aliceFp,
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

  it('rejects first messages that claim an existing contact without a valid intro (A-03)', async () => {
    const aliceKeysBefore = new Uint8Array(contactFor(aliceFp)!.dhPk);
    await endSession();
    const attacker = deriveMask(generateMasterSeed(), 0);
    const inbox = blindedInboxId(bobPks.dhPk);
    const conversationId = [aliceFp, bobFp].sort().join(':');

    /** A first message from a fresh session that claims to be Alice. */
    const forge = (msgId: string, withAttackerIntro: boolean): string => {
      const state = initAliceSession(bobPks.dhPk);
      const intro = withAttackerIntro
        ? createIntro(attacker, state.localDhPk, bobPks.signPk, bobPks.dhPk)
        : undefined;
      const enc = ratchetEncryptMessage({
        state,
        plaintext: encodeInner({ body: 'evil', intro }),
        threadId: conversationId,
        retention: 'persistent',
        senderFp: aliceFp,
        msgId,
      });
      return EnvelopeCodec.encode({ inbox, ...enc, id: msgId });
    };

    // 1. No intro at all. 2. A valid intro, but for the attacker's own identity.
    assert.equal(await rawSend(server.url, inbox, forge('forged-1', false)), 'ACCEPTED');
    assert.equal(await rawSend(server.url, inbox, forge('forged-2', true)), 'ACCEPTED');

    await openAs(BOB_PIN);
    await sleep(400);
    assert.equal(allMessages().some((m) => m.body === 'evil'), false);
    assert.ok(timingSafeEqual(contactFor(aliceFp)!.dhPk, aliceKeysBefore), 'Alice record untouched');
  });

  it('refuses oversized messages before storing or sending anything', async () => {
    const aliceOnBob = contactFor(aliceFp)!;
    const before = allMessages().length;
    await assert.rejects(
      messageService.sendMessage({
        threadId: threadIdFor(aliceOnBob),
        contact: aliceOnBob,
        body: 'x'.repeat(MAX_MESSAGE_BYTES + 1),
        retention: 'persistent',
        senderFp: bobFp,
      }),
      MessageTooLargeError,
    );
    assert.equal(allMessages().length, before);
  });

  it('flags a re-imported identity with a new exchange key as CHANGED_IDENTITY (A-11)', async () => {
    await endSession();
    const alice = await openAs(ALICE_PIN);
    // Bob's identity key arrives again with a different exchange key, as a
    // verified invite would after a reinstall or a substitution attempt.
    const bobOnAlice = contactFor(bobFp)!;
    const newExchangeKey = deriveMask(generateMasterSeed(), 1).dhPk;
    const { contact } = contactManager.createFromInvite(
      {
        v: 1,
        ik: bobOnAlice.signPk,
        xk: newExchangeKey,
        rz: new Uint8Array(16),
        exp: Math.floor(Date.now() / 1000) + 60,
        fingerprint: '',
        rendezvousInbox: '',
      },
      alice.index,
    );
    assert.equal(contact.id, bobOnAlice.id, 'same identity key reuses the contact');
    assert.equal(contactManager.getContact(contact.id)!.verificationState, 'CHANGED_IDENTITY');
  });

  it('tears down every component on lock (A-10)', async () => {
    await endSession();
    assert.equal(isVaultOpen(), false);
    assert.equal(relayClient.currentStatus, 'disconnected');
    assert.equal(identityManager.getActiveMask(), null);
    assert.equal(RamVault.size, 0);
  });
});
