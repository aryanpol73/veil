/**
 * ============================================================================
 *  VEIL — RELAY BUS (CROSS-NODE FAN-OUT INTERFACE)
 * ============================================================================
 *  The relay uses a pub/sub bus exclusively for transient cross-node routing.
 *  There is NO Redis SET, NO Redis Stream, NO disk persistence, and NO keys
 *  with TTL.
 *
 *  Two implementations:
 *    1. InMemoryRelayBus: Zero dependencies, volatile in-process fanout for
 *       development, testing, and single-node instances.
 *    2. RedisRelayBus: Real ioredis pub/sub for production multi-node clusters.
 * ============================================================================
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';

export interface RelayEnvelope {
  id: string;
  inbox: string;
  env: string; // base64 padded ciphertext
  expiresAt: number;
}

export interface RelayBus {
  publishEnvelope(envelope: RelayEnvelope): Promise<void>;
  announceInbox(inbox: string): Promise<void>;
  subscribe(
    onEnvelope: (envelope: RelayEnvelope) => void,
    onAnnounce: (inbox: string) => void,
  ): Promise<void>;
  close(): Promise<void>;
}

export const CH_DELIVER = 'veil:relay:deliver';
export const CH_ANNOUNCE = 'veil:relay:announce';

/**
 * Every bus message is tagged with the publishing node's random ID, and a
 * node ignores its own tags. Without this, a node re-delivers every envelope
 * it just fanned out locally. The ID is per-process and carries no meaning.
 */
const newNodeId = (): string => randomBytes(8).toString('hex');

/**
 * Volatile in-memory bus for single-node development, unit testing, and memory-only deployments.
 */
export class InMemoryRelayBus implements RelayBus {
  private emitter = new EventEmitter();
  private readonly nodeId = newNodeId();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  async publishEnvelope(envelope: RelayEnvelope): Promise<void> {
    this.emitter.emit(CH_DELIVER, { origin: this.nodeId, envelope });
  }

  async announceInbox(inbox: string): Promise<void> {
    this.emitter.emit(CH_ANNOUNCE, { origin: this.nodeId, inbox });
  }

  async subscribe(
    onEnvelope: (envelope: RelayEnvelope) => void,
    onAnnounce: (inbox: string) => void,
  ): Promise<void> {
    this.emitter.on(CH_DELIVER, (m: { origin: string; envelope: RelayEnvelope }) => {
      if (m.origin !== this.nodeId) onEnvelope(m.envelope);
    });
    this.emitter.on(CH_ANNOUNCE, (m: { origin: string; inbox: string }) => {
      if (m.origin !== this.nodeId) onAnnounce(m.inbox);
    });
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

/**
 * Production Redis bus using real ioredis Pub/Sub channels.
 */
export class RedisRelayBus implements RelayBus {
  private pub: Redis;
  private sub: Redis;
  private readonly nodeId = newNodeId();

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false });
    this.sub = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false });

    this.pub.on('error', (err) => {
      process.stderr.write(`[veil-bus][pub] ${String(err)}\n`);
    });
    this.sub.on('error', (err) => {
      process.stderr.write(`[veil-bus][sub] ${String(err)}\n`);
    });
  }

  async subscribe(
    onEnvelope: (envelope: RelayEnvelope) => void,
    onAnnounce: (inbox: string) => void,
  ): Promise<void> {
    await Promise.all([this.pub.connect(), this.sub.connect()]);
    await this.sub.subscribe(CH_DELIVER, CH_ANNOUNCE);

    this.sub.on('message', (channel: string, raw: string) => {
      try {
        const msg = JSON.parse(raw);
        if (!msg || msg.origin === this.nodeId) return;
        if (channel === CH_DELIVER && msg.envelope) {
          onEnvelope(msg.envelope as RelayEnvelope);
        } else if (channel === CH_ANNOUNCE && typeof msg.inbox === 'string') {
          onAnnounce(msg.inbox);
        }
      } catch {
        /* Discard malformed bus traffic */
      }
    });
  }

  async publishEnvelope(envelope: RelayEnvelope): Promise<void> {
    try {
      await this.pub.publish(CH_DELIVER, JSON.stringify({ origin: this.nodeId, envelope }));
    } catch {
      /* ignore transient publish drop */
    }
  }

  async announceInbox(inbox: string): Promise<void> {
    try {
      await this.pub.publish(CH_ANNOUNCE, JSON.stringify({ origin: this.nodeId, inbox }));
    } catch {
      /* ignore transient publish drop */
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

export function createRelayBus(config: { type: 'memory' | 'redis'; redisUrl?: string }): RelayBus {
  if (config.type === 'redis') {
    if (!config.redisUrl) {
      throw new Error('[veil-bus] Redis URL required when type is redis');
    }
    return new RedisRelayBus(config.redisUrl);
  }
  return new InMemoryRelayBus();
}
