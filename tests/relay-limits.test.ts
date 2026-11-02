/**
 * ============================================================================
 *  VEIL — RELAY ADMISSION CONTROL TESTS (audit A-14, A-17)
 * ============================================================================
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { startRelayServer, type RelayServerHandle } from '../server/src/relay';
import { deriveMask, generateMasterSeed, signInboxAuth, fromB64 } from '../client/src/crypto/keys';

interface Client {
  send: (obj: unknown) => void;
  next: (pred?: (f: any) => boolean, ms?: number) => Promise<any>;
  quiet: (ms: number) => Promise<any[]>;
  nonce: Uint8Array;
  close: () => void;
}

async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url);
  const frames: any[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  const next = async (pred: (f: any) => boolean = () => true, ms = 3000): Promise<any> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = frames.findIndex(pred);
      if (i !== -1) return frames.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error('timed out waiting for frame');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const hello = await next((f) => f.t === 'HELLO');
  return {
    send: (obj) => ws.send(JSON.stringify(obj)),
    next,
    quiet: async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return frames.splice(0);
    },
    nonce: fromB64(hello.nonce),
    close: () => ws.close(),
  };
}

const envelope = () => randomBytes(4096).toString('base64');
const inboxId = () => randomBytes(32).toString('base64url');

describe('Relay admission control', () => {
  const servers: RelayServerHandle[] = [];
  after(async () => {
    for (const s of servers) await s.close();
  });

  it('answers DROPPED instead of silently evicting when an inbox queue is full', async () => {
    const server = await startRelayServer(0, { busType: 'memory', maxQueueDepth: 2 });
    servers.push(server);
    const c = await connect(server.url);
    const inbox = inboxId();

    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      c.send({ t: 'SEND', inbox, env: envelope() });
      results.push((await c.next((f) => f.t === 'ACCEPTED' || f.t === 'DROPPED')).t);
    }
    assert.deepEqual(results, ['ACCEPTED', 'ACCEPTED', 'DROPPED']);
    c.close();
    await server.close();
    servers.pop();
  });

  it('enforces the global buffered-bytes budget', async () => {
    const server = await startRelayServer(0, { busType: 'memory', maxBufferedBytes: 6000 });
    servers.push(server);
    const c = await connect(server.url);

    c.send({ t: 'SEND', inbox: inboxId(), env: envelope() });
    assert.equal((await c.next((f) => f.t === 'ACCEPTED' || f.t === 'DROPPED')).t, 'ACCEPTED');
    c.send({ t: 'SEND', inbox: inboxId(), env: envelope() });
    assert.equal((await c.next((f) => f.t === 'ACCEPTED' || f.t === 'DROPPED')).t, 'DROPPED');
    c.close();
    await server.close();
    servers.pop();
  });

  it('rejects malformed inbox IDs on SUB as well as on SEND', async () => {
    const server = await startRelayServer(0, { busType: 'memory' });
    servers.push(server);
    const c = await connect(server.url);

    c.send({ t: 'SUB', inbox: 'short', pk: 'x', sig: 'y' });
    assert.equal((await c.next((f) => f.t === 'ERR')).code, 'INBOX_FORM');
    c.send({ t: 'SUB', inbox: { not: 'a string' }, pk: 'x', sig: 'y' });
    assert.equal((await c.next((f) => f.t === 'ERR')).code, 'INBOX_FORM');
    c.send({ t: 'SEND', inbox: 'has spaces in it!!!!', env: envelope() });
    assert.equal((await c.next((f) => f.t === 'ERR')).code, 'INBOX_FORM');
    c.send(42);
    assert.equal((await c.next((f) => f.t === 'ERR')).code, 'PARSE');
    c.close();
  });

  it('delivers each envelope exactly once with the bus wired (no self-echo)', async () => {
    const server = servers[servers.length - 1];
    const mask = deriveMask(generateMasterSeed(), 0);
    const inbox = inboxId();

    const sub = await connect(server.url);
    const auth = signInboxAuth(mask, inbox, sub.nonce);
    sub.send({ t: 'SUB', inbox, pk: auth.signPk, sig: auth.signature });
    await sub.next((f) => f.t === 'SUBBED');

    const sender = await connect(server.url);
    sender.send({ t: 'SEND', inbox, env: envelope() });
    await sender.next((f) => f.t === 'ACCEPTED');

    const frames = await sub.quiet(300);
    assert.equal(frames.filter((f) => f.t === 'DELIVER').length, 1);
    sub.close();
    sender.close();
  });
});
