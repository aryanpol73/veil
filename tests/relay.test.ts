/**
 * ============================================================================
 *  VEIL — BLIND RELAY INTEGRATION TEST SUITE
 * ============================================================================
 *  Tests:
 *   - Ephemeral WebSocket server lifecycle (HELLO, nonce handshake)
 *   - First-claim inbox authorization with Ed25519 signatures
 *   - Epoch claim conflict denial (different key cannot hijack inbox)
 *   - Valid re-claim by same key with fresh challenge nonce
 *   - 4096-byte uniform envelope transmission (SEND / ACCEPTED)
 *   - Real-time DELIVER to connected subscriber
 *   - Volatile RAM buffering when subscriber is offline, delivered upon SUB
 *   - ACK dropping envelope from RAM
 *   - PING / PONG heartbeat and NOOP cover traffic
 *   - Malformed / non-4096-byte envelope rejection
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
  type MaskIdentity,
} from '../client/src/crypto/keys';
import { padEnvelope, unpadEnvelope } from '../client/src/crypto/padding';

describe('Veil Blind WebSocket Relay', () => {
  let server: RelayServerHandle;
  let serverUrl: string;

  before(async () => {
    // Start on ephemeral port 0 with in-memory bus
    server = await startRelayServer(0, { busType: 'memory' });
    serverUrl = server.url;
  });

  after(async () => {
    await server.close();
  });

  // Helper to open socket and await HELLO frame
  async function connectClient(): Promise<{
    ws: WebSocket;
    nonce: Uint8Array;
    envelopeBytes: number;
    nextFrame: () => Promise<any>;
    close: () => void;
  }> {
    const ws = new WebSocket(serverUrl);
    const queue: any[] = [];
    const waiters: ((frame: any) => void)[] = [];

    ws.on('message', (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString('utf8'));
      if (waiters.length > 0) {
        const resolve = waiters.shift()!;
        resolve(frame);
      } else {
        queue.push(frame);
      }
    });

    const nextFrame = (): Promise<any> => {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift());
      }
      return new Promise((resolve) => waiters.push(resolve));
    };

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', (err) => reject(err));
    });

    const hello = await nextFrame();
    assert.equal(hello.t, 'HELLO');
    assert.equal(hello.v, 1);
    assert.ok(hello.nonce);
    assert.equal(hello.envelopeBytes, 4096);

    const nonce = fromB64(hello.nonce);

    return {
      ws,
      nonce,
      envelopeBytes: hello.envelopeBytes,
      nextFrame,
      close: () => ws.close(),
    };
  }

  it('completes HELLO handshake and returns fresh 32-byte challenge nonce', async () => {
    const client = await connectClient();
    assert.equal(client.nonce.length, 32);
    client.close();
  });

  it('authorizes inbox with valid Ed25519 signature and returns SUBBED', async () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    const inbox = 'inbox_auth_test_1';

    const client = await connectClient();
    const auth = signInboxAuth(mask, inbox, client.nonce);

    client.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox,
        pk: auth.signPk,
        sig: auth.signature,
      })
    );

    const res = await client.nextFrame();
    assert.equal(res.t, 'SUBBED');
    assert.equal(res.inbox, inbox);
    client.close();
  });

  it('rejects SUB with invalid / tampered signature and returns DENIED', async () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    const inbox = 'inbox_tamper_test';

    const client = await connectClient();
    const auth = signInboxAuth(mask, inbox, client.nonce);

    // Corrupt the signature
    const corruptSig = auth.signature.slice(0, -4) + 'AAAA';

    client.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox,
        pk: auth.signPk,
        sig: corruptSig,
      })
    );

    const res = await client.nextFrame();
    assert.equal(res.t, 'DENIED');
    assert.equal(res.inbox, inbox);
    client.close();
  });

  it('enforces first-claim inbox ownership and denies unauthorized hijacking', async () => {
    const seedAlice = generateMasterSeed();
    const alice = deriveMask(seedAlice, 0);

    const seedEve = generateMasterSeed();
    const eve = deriveMask(seedEve, 0);

    const contestedInbox = 'inbox_first_claim_test';

    // Alice claims inbox first
    const clientAlice = await connectClient();
    const authAlice = signInboxAuth(alice, contestedInbox, clientAlice.nonce);
    clientAlice.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox: contestedInbox,
        pk: authAlice.signPk,
        sig: authAlice.signature,
      })
    );
    const resAlice = await clientAlice.nextFrame();
    assert.equal(resAlice.t, 'SUBBED');

    // Eve tries to claim the same inbox during the same epoch
    const clientEve = await connectClient();
    const authEve = signInboxAuth(eve, contestedInbox, clientEve.nonce);
    clientEve.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox: contestedInbox,
        pk: authEve.signPk,
        sig: authEve.signature,
      })
    );
    const resEve = await clientEve.nextFrame();
    assert.equal(resEve.t, 'DENIED'); // Eve is denied!

    // Alice connects from a second device with the same identity
    const clientAlice2 = await connectClient();
    const authAlice2 = signInboxAuth(alice, contestedInbox, clientAlice2.nonce);
    clientAlice2.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox: contestedInbox,
        pk: authAlice2.signPk,
        sig: authAlice2.signature,
      })
    );
    const resAlice2 = await clientAlice2.nextFrame();
    assert.equal(resAlice2.t, 'SUBBED'); // Legitimate owner accepted!

    clientAlice.close();
    clientEve.close();
    clientAlice2.close();
  });

  it('delivers 4096-byte padded envelope in real-time to active subscriber', async () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    const inbox = 'inbox_realtime_send';

    const subClient = await connectClient();
    const auth = signInboxAuth(mask, inbox, subClient.nonce);
    subClient.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox,
        pk: auth.signPk,
        sig: auth.signature,
      })
    );
    const subRes = await subClient.nextFrame();
    assert.equal(subRes.t, 'SUBBED');

    // Sender prepares 4096-byte uniform envelope
    const rawPayload = Buffer.from(JSON.stringify({ v: 1, text: 'Hello over blind relay!' }));
    const padded = padEnvelope(rawPayload, 4096);
    assert.equal(padded.length, 4096);
    const b64Env = toB64(padded);

    const senderClient = await connectClient();
    senderClient.ws.send(
      JSON.stringify({
        t: 'SEND',
        inbox,
        env: b64Env,
      })
    );

    // Sender gets ACCEPTED
    const sendRes = await senderClient.nextFrame();
    assert.equal(sendRes.t, 'ACCEPTED');
    assert.equal(sendRes.inbox, inbox);
    assert.ok(sendRes.id);

    // Subscriber gets DELIVER
    const deliverRes = await subClient.nextFrame();
    assert.equal(deliverRes.t, 'DELIVER');
    assert.equal(deliverRes.inbox, inbox);
    assert.equal(deliverRes.id, sendRes.id);
    assert.equal(deliverRes.env, b64Env);

    // Unpad and verify content
    const unpadded = unpadEnvelope(fromB64(deliverRes.env));
    const parsed = JSON.parse(Buffer.from(unpadded).toString('utf8'));
    assert.equal(parsed.text, 'Hello over blind relay!');

    subClient.close();
    senderClient.close();
  });

  it('buffers envelope in RAM for offline recipient and delivers upon SUB', async () => {
    const seed = generateMasterSeed();
    const mask = deriveMask(seed, 0);
    const inbox = 'inbox_offline_buffer_test';

    // Sender transmits while recipient is offline
    const rawPayload = Buffer.from(JSON.stringify({ msg: 'Stored in volatile RAM' }));
    const padded = padEnvelope(rawPayload, 4096);
    const b64Env = toB64(padded);

    const sender = await connectClient();
    sender.ws.send(
      JSON.stringify({
        t: 'SEND',
        inbox,
        env: b64Env,
      })
    );
    const sendRes = await sender.nextFrame();
    assert.equal(sendRes.t, 'ACCEPTED');
    sender.close();

    // Recipient connects later and subscribes
    const recipient = await connectClient();
    const auth = signInboxAuth(mask, inbox, recipient.nonce);
    recipient.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox,
        pk: auth.signPk,
        sig: auth.signature,
      })
    );

    const subRes = await recipient.nextFrame();
    assert.equal(subRes.t, 'SUBBED');

    // Recipient immediately receives queued DELIVER frame
    const deliverRes = await recipient.nextFrame();
    assert.equal(deliverRes.t, 'DELIVER');
    assert.equal(deliverRes.id, sendRes.id);
    assert.equal(deliverRes.env, b64Env);

    // Recipient ACKs delivery
    recipient.ws.send(
      JSON.stringify({
        t: 'ACK',
        inbox,
        ids: [deliverRes.id],
      })
    );

    // Allow ACK to process
    await new Promise((r) => setTimeout(r, 50));
    recipient.close();

    // Now connect another client for the same inbox: no more queued messages!
    const recipient2 = await connectClient();
    const auth2 = signInboxAuth(mask, inbox, recipient2.nonce);
    recipient2.ws.send(
      JSON.stringify({
        t: 'SUB',
        inbox,
        pk: auth2.signPk,
        sig: auth2.signature,
      })
    );
    const subRes2 = await recipient2.nextFrame();
    assert.equal(subRes2.t, 'SUBBED');

    // Send PING to verify no DELIVER frame is queued ahead of PONG
    recipient2.ws.send(JSON.stringify({ t: 'PING' }));
    const pongRes = await recipient2.nextFrame();
    assert.equal(pongRes.t, 'PONG'); // Immediate PONG, no DELIVER

    recipient2.close();
  });

  it('rejects non-4096-byte envelopes with BAD_ENVELOPE error', async () => {
    const inbox = 'inbox_bad_size_test';
    const client = await connectClient();

    // Send unpadded tiny envelope (not 4096 bytes)
    const badEnv = toB64(Buffer.from('tiny unpadded ciphertext'));
    client.ws.send(
      JSON.stringify({
        t: 'SEND',
        inbox,
        env: badEnv,
      })
    );

    const res = await client.nextFrame();
    assert.equal(res.t, 'ERR');
    assert.equal(res.code, 'ENVELOPE_SIZE');
    client.close();
  });

  it('responds to PING with PONG and accepts NOOP cover traffic silently', async () => {
    const client = await connectClient();

    // Send NOOP (cover traffic)
    client.ws.send(JSON.stringify({ t: 'NOOP' }));

    // Send PING
    client.ws.send(JSON.stringify({ t: 'PING' }));
    const pong = await client.nextFrame();
    assert.equal(pong.t, 'PONG');

    client.close();
  });
});
