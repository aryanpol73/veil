/**
 * ============================================================================
 *  VEIL — BLIND WEBSOCKET RELAY
 * ============================================================================
 *  The relay is a dumb, forgetful mailbox. Its complete knowledge of the world:
 *
 *    - a set of opaque, hourly-rotating inbox IDs that someone subscribed to
 *    - opaque ciphertext blobs, held in RAM, dropped the instant they are ACKed
 *
 *  It has NO accounts, NO passwords, NO contact graph, NO message history, NO
 *  access log, and NO disk writes. Redis is used exclusively as a pub/sub bus
 *  for cross-node fan-out — never SET, never a Stream, never a key with a TTL.
 *  Restarting the process is a complete and irreversible data wipe.
 *
 *  SUBSCRIBER AUTHORIZATION WITHOUT IDENTITY
 *  Since there is no directory, the relay cannot know who "owns" an inbox. It
 *  uses first-claim registration, held in RAM only: the first Ed25519 key to
 *  claim a blinded inbox ID within an epoch owns it for that epoch, and every
 *  subsequent claim must prove possession of that same key over a fresh
 *  server nonce. This stops a passive eavesdropper who learned an inbox ID
 *  from stealing its mail, without the relay ever learning a persistent
 *  identity — the claiming key is itself an ephemeral per-inbox subkey and the
 *  registration evaporates when the epoch rolls or the process restarts.
 *
 *  KNOWN LIMITS, stated plainly: an active adversary who controls the relay
 *  from before a user's very first subscription of an epoch can pre-claim that
 *  inbox. Defeating that requires the client to pin the relay's key and detect
 *  claim rejection — implemented client-side, out of scope for this file. And
 *  a global passive observer can still correlate connection timing; the fixed
 *  envelope size and NOOP cover traffic below raise the cost but do not
 *  eliminate it.
 * ============================================================================
 */

import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createRelayBus, type RelayBus, type RelayEnvelope } from './bus.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const _sodium = require('libsodium-wrappers');

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

const CONFIG = {
  port: Number(process.env.VEIL_PORT ?? 8443),
  redisUrl: process.env.VEIL_REDIS_URL ?? 'redis://127.0.0.1:6379',
  busType: (process.env.VEIL_BUS === 'redis' ? 'redis' : 'memory') as 'memory' | 'redis',

  /** Fixed padded envelope size. Uniformity denies size-correlation attacks. */
  envelopeBytes: 4096,
  maxFrameBytes: 8192,

  /** Volatile buffering. Nothing survives these bounds. */
  bufferTtlMs: 24 * 3_600_000,
  maxQueueDepth: 256,
  maxQueuedInboxes: 200_000,
  /** Global cap on buffered envelope bytes across all inboxes. */
  maxBufferedBytes: 256 * 1024 * 1024,
  /** Global cap on live first-claim registrations. */
  maxClaims: 500_000,

  /** Per-connection limits. */
  maxSubsPerConn: 1024, // wire v2: a few inboxes per contact
  ratePerSec: 50,
  rateBurst: 200,
  idleTimeoutMs: 90_000,
  heartbeatMs: 25_000,

  /** Inbox claim lifetime — two epoch hours, matching the client's window. */
  claimTtlMs: 2 * 3_600_000,
} as const;

/**
 * We emit NO access log, NO IP, NO inbox ID, and NO timestamp-correlatable
 * per-message line. Only aggregate counters and fatal faults. A verbose relay
 * log is a metadata database with extra steps.
 */
const log = {
  boot: (m: string) => process.stdout.write(`[veil-relay] ${m}\n`),
  fault: (m: string) => process.stderr.write(`[veil-relay][fault] ${m}\n`),
};

/* -------------------------------------------------------------------------- */
/* Protocol                                                                   */
/* -------------------------------------------------------------------------- */

type ClientFrame =
  | { t: 'HELLO'; v: 1 }
  | { t: 'SUB'; inbox: string; pk: string; sig: string }
  | { t: 'UNSUB'; inbox: string }
  | { t: 'SEND'; inbox: string; env: string }
  | { t: 'ACK'; inbox: string; ids: string[] }
  | { t: 'NOOP' }
  | { t: 'PING' };

type ServerFrame =
  | { t: 'HELLO'; v: 1; nonce: string; envelopeBytes: number }
  | { t: 'SUBBED'; inbox: string }
  | { t: 'DENIED'; inbox: string }
  | { t: 'DELIVER'; inbox: string; id: string; env: string }
  | { t: 'ACCEPTED'; inbox: string; id: string }
  | { t: 'DROPPED'; inbox: string; reason: 'full' }
  | { t: 'PONG' }
  | { t: 'ERR'; code: string };

interface Envelope {
  id: string;
  inbox: string;
  env: string; // base64 ciphertext, fixed padded length
  expiresAt: number;
}

/* -------------------------------------------------------------------------- */
/* Volatile state                                                            */
/* -------------------------------------------------------------------------- */

/** inbox -> pending envelopes. RAM only. Never serialized anywhere. */
const queues = new Map<string, Envelope[]>();

/** inbox -> local live subscribers. */
const subscribers = new Map<string, Set<Conn>>();

/** inbox -> first-claim owner key + expiry. RAM only, epoch-scoped. */
const claims = new Map<string, { pk: Uint8Array; expiresAt: number }>();

/** Running total of buffered `env` bytes, enforced against maxBufferedBytes. */
let bufferedBytes = 0;

/** Limits in force for the running server (CONFIG plus test overrides). */
let limits: typeof CONFIG = CONFIG;

const isInboxId = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 16 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v);

interface Conn {
  ws: WebSocket;
  /** Per-connection challenge; every SUB signature is bound to it. */
  nonce: Buffer;
  subs: Set<string>;
  /** Token bucket. */
  tokens: number;
  lastRefill: number;
  alive: boolean;
  lastSeen: number;
}

const conns = new Set<Conn>();

/* -------------------------------------------------------------------------- */
/* Crypto                                                                     */
/* -------------------------------------------------------------------------- */

let sodium: typeof _sodium;

const b64 = {
  dec(s: string): Uint8Array {
    return new Uint8Array(Buffer.from(s, 'base64url'));
  },
};

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

/** Same preimage the client builds in `signInboxAuth`. */
function authPreimage(inbox: string, nonce: Buffer): Uint8Array {
  const prefix = utf8(`veil.inbox.auth.v1|${inbox}|`);
  const out = new Uint8Array(prefix.length + nonce.length);
  out.set(prefix, 0);
  out.set(nonce, prefix.length);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Pub/sub bus (fan-out only)                                                 */
/* -------------------------------------------------------------------------- */

let bus: RelayBus;

/**
 * Cross-node routing via pluggable RelayBus (InMemoryRelayBus or RedisRelayBus):
 *
 *  - On SEND, the ingress node buffers locally AND publishes on the bus.
 *    Whichever node holds a live subscriber pushes it and returns the ACK,
 *    which drops the copy.
 *  - On SUB, the node announces the inbox. Any node holding buffered mail
 *    for that inbox re-publishes it. That is how an offline client's mail
 *    reaches it after reconnecting to a different node — with zero persistence.
 */
async function initBus(cfg: typeof CONFIG): Promise<void> {
  bus = createRelayBus({ type: cfg.busType, redisUrl: cfg.redisUrl });
  log.boot(`bus: ${cfg.busType}${cfg.busType === 'redis' ? ' (redis)' : ' (in-memory volatile)'}`);

  // The bus drops this node's own publications, so a single node never
  // re-delivers to itself.
  await bus.subscribe(
    (envelope: RelayEnvelope) => {
      // Only act if WE hold a subscriber; otherwise ignore entirely.
      if (subscribers.has(envelope.inbox)) fanOut(envelope as Envelope, false);
    },
    (inbox: string) => {
      if (isInboxId(inbox)) flushLocalBuffer(inbox);
    },
  );
}

/* -------------------------------------------------------------------------- */
/* Queue mechanics                                                            */
/* -------------------------------------------------------------------------- */

function send(conn: Conn, frame: ServerFrame): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  try {
    conn.ws.send(JSON.stringify(frame));
  } catch {
    /* the socket is dying; the close handler will clean up */
  }
}

/**
 * Pushes to local subscribers; buffers only if none and `allowBuffer`.
 * Returns false if the envelope could not be held.
 */
function fanOut(env: Envelope, allowBuffer: boolean): boolean {
  const set = subscribers.get(env.inbox);
  if (set && set.size > 0) {
    for (const conn of set) {
      send(conn, { t: 'DELIVER', inbox: env.inbox, id: env.id, env: env.env });
    }
    // Held pending ACK so a socket that dies mid-flight does not lose mail.
    return buffer(env);
  }
  return allowBuffer ? buffer(env) : true;
}

/**
 * Holds an envelope until ACK or expiry. Returns false when a limit is hit;
 * the sender is then told DROPPED so it can retry. Nothing is ever evicted to
 * make room, since silent eviction is undetectable data loss (audit A-14).
 */
function buffer(env: Envelope): boolean {
  let q = queues.get(env.inbox);
  if (q?.some((e) => e.id === env.id)) return true; // idempotent across bus echoes
  if (bufferedBytes + env.env.length > limits.maxBufferedBytes) return false;
  if (q && q.length >= limits.maxQueueDepth) return false;
  if (!q) {
    if (queues.size >= limits.maxQueuedInboxes) return false; // shed, never spill to disk
    q = [];
    queues.set(env.inbox, q);
  }
  q.push(env);
  bufferedBytes += env.env.length;
  return true;
}

function releaseBytes(envs: Envelope[]): void {
  for (const e of envs) bufferedBytes -= e.env.length;
  if (bufferedBytes < 0) bufferedBytes = 0;
}

function flushLocalBuffer(inbox: string): void {
  const q = queues.get(inbox);
  if (!q || q.length === 0) return;
  const now = Date.now();
  const live = q.filter((e) => e.expiresAt > now);
  releaseBytes(q.filter((e) => e.expiresAt <= now));
  if (live.length === 0) {
    queues.delete(inbox);
    return;
  }
  queues.set(inbox, live);

  const set = subscribers.get(inbox);
  if (set && set.size > 0) {
    for (const conn of set) {
      for (const e of live) send(conn, { t: 'DELIVER', inbox, id: e.id, env: e.env });
    }
  } else {
    // A subscriber exists on another node — hand the mail to the bus.
    for (const e of live) {
      bus.publishEnvelope(e).catch(() => {});
    }
  }
}

/** ACK is the delete. There is no soft-delete, tombstone, or archive. */
function dropAcked(inbox: string, ids: string[]): void {
  const q = queues.get(inbox);
  if (!q) return;
  const doomed = new Set(ids);
  releaseBytes(q.filter((e) => doomed.has(e.id)));
  const remaining = q.filter((e) => !doomed.has(e.id));
  if (remaining.length === 0) queues.delete(inbox);
  else queues.set(inbox, remaining);
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

function allow(conn: Conn): boolean {
  const now = Date.now();
  // Clamped: a clock step backwards must not drain the bucket.
  const elapsed = Math.max(0, (now - conn.lastRefill) / 1000);
  conn.lastRefill = now;
  conn.tokens = Math.min(limits.rateBurst, conn.tokens + elapsed * limits.ratePerSec);
  if (conn.tokens < 1) return false;
  conn.tokens -= 1;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Frame handling                                                             */
/* -------------------------------------------------------------------------- */

function handleSub(conn: Conn, f: Extract<ClientFrame, { t: 'SUB' }>): void {
  if (!isInboxId(f.inbox)) {
    send(conn, { t: 'ERR', code: 'INBOX_FORM' });
    return;
  }
  if (conn.subs.size >= limits.maxSubsPerConn && !conn.subs.has(f.inbox)) {
    send(conn, { t: 'DENIED', inbox: f.inbox });
    return;
  }

  let pk: Uint8Array;
  let sig: Uint8Array;
  if (typeof f.pk !== 'string' || typeof f.sig !== 'string') {
    send(conn, { t: 'DENIED', inbox: f.inbox });
    return;
  }
  try {
    pk = b64.dec(f.pk);
    sig = b64.dec(f.sig);
  } catch {
    send(conn, { t: 'DENIED', inbox: f.inbox });
    return;
  }
  if (pk.length !== 32 || sig.length !== 64) {
    send(conn, { t: 'DENIED', inbox: f.inbox });
    return;
  }

  // 1. Signature must be over THIS connection's nonce — kills replay.
  if (!sodium.crypto_sign_verify_detached(sig, authPreimage(f.inbox, conn.nonce), pk)) {
    send(conn, { t: 'DENIED', inbox: f.inbox });
    return;
  }

  // 2. First-claim ownership, constant-time compared.
  const now = Date.now();
  const existing = claims.get(f.inbox);
  if (existing && existing.expiresAt > now) {
    const a = Buffer.from(existing.pk);
    const b = Buffer.from(pk);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      send(conn, { t: 'DENIED', inbox: f.inbox });
      return;
    }
  } else if (claims.size >= limits.maxClaims) {
    send(conn, { t: 'DENIED', inbox: f.inbox });
    return;
  }
  claims.set(f.inbox, { pk, expiresAt: now + limits.claimTtlMs });

  conn.subs.add(f.inbox);
  let set = subscribers.get(f.inbox);
  if (!set) {
    set = new Set();
    subscribers.set(f.inbox, set);
  }
  set.add(conn);

  send(conn, { t: 'SUBBED', inbox: f.inbox });

  // Drain anything already here, then ask peer nodes to drain too.
  flushLocalBuffer(f.inbox);
  bus.announceInbox(f.inbox).catch(() => {});
}

function handleSend(conn: Conn, f: Extract<ClientFrame, { t: 'SEND' }>): void {
  // Enforce the fixed envelope size. Rejecting non-uniform payloads is what
  // makes padding actually protective — otherwise clients degrade it silently.
  if (typeof f.env !== 'string' || Buffer.byteLength(f.env, 'base64') !== limits.envelopeBytes) {
    send(conn, { t: 'ERR', code: 'ENVELOPE_SIZE' });
    return;
  }
  if (!isInboxId(f.inbox)) {
    send(conn, { t: 'ERR', code: 'INBOX_FORM' });
    return;
  }

  const envelope: Envelope = {
    // Server-assigned: a client-chosen ID is a covert channel and a collision risk.
    id: randomBytes(12).toString('base64url'),
    inbox: f.inbox,
    env: f.env,
    expiresAt: Date.now() + limits.bufferTtlMs,
  };

  if (!fanOut(envelope, true)) {
    send(conn, { t: 'DROPPED', inbox: f.inbox, reason: 'full' });
    return;
  }
  bus.publishEnvelope(envelope).catch(() => {});
  send(conn, { t: 'ACCEPTED', inbox: f.inbox, id: envelope.id });
}

function handleFrame(conn: Conn, raw: RawData): void {
  conn.lastSeen = Date.now();

  if (Buffer.byteLength(raw as Buffer) > limits.maxFrameBytes) {
    conn.ws.close(1009, 'frame');
    return;
  }
  if (!allow(conn)) {
    send(conn, { t: 'ERR', code: 'RATE' });
    return;
  }

  let f: ClientFrame;
  try {
    f = JSON.parse((raw as Buffer).toString('utf8'));
  } catch {
    send(conn, { t: 'ERR', code: 'PARSE' });
    return;
  }
  if (!f || typeof f !== 'object' || typeof (f as { t?: unknown }).t !== 'string') {
    send(conn, { t: 'ERR', code: 'PARSE' });
    return;
  }

  switch (f.t) {
    case 'HELLO':
      send(conn, {
        t: 'HELLO',
        v: 1,
        nonce: conn.nonce.toString('base64url'),
        envelopeBytes: limits.envelopeBytes,
      });
      break;
    case 'SUB':
      handleSub(conn, f);
      break;
    case 'UNSUB':
      if (!isInboxId(f.inbox)) break;
      conn.subs.delete(f.inbox);
      subscribers.get(f.inbox)?.delete(conn);
      if (subscribers.get(f.inbox)?.size === 0) subscribers.delete(f.inbox);
      break;
    case 'SEND':
      handleSend(conn, f);
      break;
    case 'ACK':
      if (isInboxId(f.inbox) && conn.subs.has(f.inbox) && Array.isArray(f.ids)) {
        dropAcked(
          f.inbox,
          f.ids.slice(0, 256).filter((id): id is string => typeof id === 'string'),
        );
      }
      break;
    case 'NOOP':
      // Client cover traffic. Accepted and discarded — its only purpose is to
      // make real sends indistinguishable from idling to a network observer.
      break;
    case 'PING':
      send(conn, { t: 'PONG' });
      break;
    default:
      send(conn, { t: 'ERR', code: 'UNKNOWN' });
  }
}

/* -------------------------------------------------------------------------- */
/* Server Lifecycle                                                           */
/* -------------------------------------------------------------------------- */

export interface RelayServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
  http: any;
  wss: any;
  bus: RelayBus;
}

export async function startRelayServer(
  port: number = CONFIG.port,
  configOverrides: Partial<typeof CONFIG> = {}
): Promise<RelayServerHandle> {
  const cfg = { ...CONFIG, ...configOverrides, port };
  limits = cfg;
  await _sodium.ready;
  sodium = _sodium;
  await initBus(cfg);

  // No request logging middleware, deliberately. `/healthz` returns a bare 200
  // with no version string or counters — a fingerprintable banner is metadata.
  const http = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    server: http,
    maxPayload: cfg.maxFrameBytes,
    // Compression OFF: a shared compression context across messages leaks
    // plaintext similarity through ciphertext length (CRIME/BREACH-style).
    perMessageDeflate: false,
    clientTracking: false,
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // The socket is the only handle we keep. `req` — and therefore the source
    // IP, User-Agent and headers — is intentionally never read or stored.
    void req;

    ws.binaryType = 'nodebuffer';
    (req.socket as any)?.setNoDelay?.(true);

    const conn: Conn = {
      ws,
      nonce: randomBytes(32),
      subs: new Set(),
      tokens: cfg.rateBurst,
      lastRefill: Date.now(),
      alive: true,
      lastSeen: Date.now(),
    };
    conns.add(conn);

    send(conn, {
      t: 'HELLO',
      v: 1,
      nonce: conn.nonce.toString('base64url'),
      envelopeBytes: cfg.envelopeBytes,
    });

    ws.on('message', (raw) => handleFrame(conn, raw));
    ws.on('pong', () => {
      conn.alive = true;
      conn.lastSeen = Date.now();
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      for (const inbox of conn.subs) {
        const set = subscribers.get(inbox);
        set?.delete(conn);
        if (set && set.size === 0) subscribers.delete(inbox);
      }
      conn.subs.clear();
      conn.nonce.fill(0);
      conns.delete(conn);
    });
  });

  /* ---- Heartbeat + idle reaping --------------------------------------- */

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of conns) {
      if (!conn.alive || now - conn.lastSeen > cfg.idleTimeoutMs) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }, cfg.heartbeatMs);

  /* ---- Expiry sweep ---------------------------------------------------- */

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [inbox, q] of queues) {
      const live = q.filter((e) => e.expiresAt > now);
      releaseBytes(q.filter((e) => e.expiresAt <= now));
      if (live.length === 0) queues.delete(inbox);
      else if (live.length !== q.length) queues.set(inbox, live);
    }
    for (const [inbox, claim] of claims) {
      if (claim.expiresAt <= now) {
        claim.pk.fill(0);
        claims.delete(inbox);
      }
    }
  }, 60_000);

  /* ---- Shutdown: zeroize everything before exiting -------------------- */

  const close = async () => {
    clearInterval(heartbeat);
    clearInterval(sweep);

    for (const conn of conns) {
      try {
        conn.ws.close(1001, 'restart');
      } catch {
        /* already gone */
      }
    }

    // Overwrite buffered ciphertext before releasing it to the GC, so a core
    // dump taken after SIGTERM does not yield deliverable envelopes.
    for (const q of queues.values()) {
      for (const e of q) e.env = '';
    }
    queues.clear();
    bufferedBytes = 0;
    subscribers.clear();
    for (const c of claims.values()) c.pk.fill(0);
    claims.clear();

    await bus.close();
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };

  await new Promise<void>((resolve) => {
    http.listen(port, () => {
      const addr = http.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      log.boot(`blind relay listening :${actualPort}`);
      resolve();
    });
  });

  const addr = http.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    port: actualPort,
    url: `ws://127.0.0.1:${actualPort}`,
    close,
    http,
    wss,
    bus,
  };
}

export { CONFIG };

// Self-executing if run directly
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('relay.ts') || process.argv[1].endsWith('relay.js'));

if (isDirectRun) {
  startRelayServer(CONFIG.port).then((server) => {
    const shutdown = async (signal: string) => {
      log.boot(`shutdown (${signal})`);
      await server.close();
      process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('unhandledRejection', (e) => log.fault(String(e)));
  }).catch((e) => {
    log.fault(String(e));
    process.exit(1);
  });
}

