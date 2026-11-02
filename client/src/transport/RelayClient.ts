/**
 * ============================================================================
 *  VEIL — RELAY CLIENT & TRANSPORT MANAGER
 * ============================================================================
 *  Handles WebSocket communication with the blind relay:
 *   - Challenge-nonce authentication on connection
 *   - Inbox subscriptions with Ed25519 signatures
 *   - Envelope transmission and delivery acknowledgment (ACK-on-receive)
 *   - Auto-resubscription across reconnects
 *   - Exponential backoff with full jitter
 *   - NOOP cover traffic during idle periods
 * ============================================================================
 */

import { fromB64, signInboxAuth } from '../crypto/keys';
import type { InboxSigner } from '../protocol/pairing';
import type { ServerFrame } from '../types/models';
import { ReconnectPolicy } from './ReconnectPolicy';
import { RelayProtocol } from './RelayProtocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface RelayClientConfig {
  url?: string;
  heartbeatMs?: number;
  noopIntervalMs?: number;
  sendTimeoutMs?: number;
}

/**
 * Returns true once the envelope has been durably handled (decrypted and
 * committed, or judged permanently unprocessable). Only then does the client
 * ACK, which deletes the relay's copy. Returning false leaves the envelope at
 * the relay for redelivery on the next subscription (audit A-15).
 */
export type DeliverCallback = (envelopeB64: string, rawId: string) => boolean;

/** Retry delay after the relay denies a subscription. */
const DENIED_RETRY_MS = 30_000;

/**
 * SUB frames are paced below the relay's per-connection rate limit, so a
 * catch-up burst (several inboxes per contact) is not answered with ERR RATE.
 */
const SUB_INTERVAL_MS = 60;

interface PendingSend {
  resolve: (id: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RelayClient {
  private url: string;
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private serverNonce: Uint8Array | null = null;
  private reconnectPolicy = new ReconnectPolicy();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private noopTimer: ReturnType<typeof setInterval> | null = null;
  private isDisposed = false;

  private subscriptions = new Map<string, { signer: InboxSigner; onDeliver: DeliverCallback }>();
  private subQueue = new Set<string>();
  private subTimer: ReturnType<typeof setInterval> | null = null;

  private pendingSends = new Map<string, PendingSend[]>();
  private deniedRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  constructor(config: RelayClientConfig = {}) {
    this.url =
      config.url ??
      (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_RELAY_URL
        ? process.env.EXPO_PUBLIC_RELAY_URL
        : 'ws://127.0.0.1:8443');
  }

  /** Points the client at another relay. Takes effect on the next connect. */
  public setUrl(url: string): void {
    this.url = url;
  }

  public get currentStatus(): ConnectionStatus {
    return this.status;
  }

  public onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(newStatus: ConnectionStatus): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    for (const listener of this.statusListeners) {
      try {
        listener(newStatus);
      } catch {
        /* ignore */
      }
    }
  }

  public connect(): void {
    if (this.ws) return;
    this.isDisposed = false;
    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        // Send client hello
        this.sendFrame(RelayProtocol.createHello());
      };

      this.ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          this.handleMessage(event.data);
        }
      };

      this.ws.onerror = () => {
        // Handled on close
      };

      this.ws.onclose = () => {
        this.cleanupSocket();
        this.setStatus('disconnected');
        this.scheduleReconnect();
      };
    } catch {
      this.cleanupSocket();
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  /**
   * Tears down everything tied to the current vault session: subscriptions
   * (which hold mask references), pending sends, timers and the socket. The
   * client stays idle until the next connect()/subscribe(), so nothing is
   * received or ACKed while the vault is locked (audit A-10).
   */
  public disconnect(): void {
    this.isDisposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const t of this.deniedRetryTimers.values()) clearTimeout(t);
    this.deniedRetryTimers.clear();
    this.subscriptions.clear();
    this.stopSubQueue();
    for (const queue of this.pendingSends.values()) {
      for (const p of queue) {
        clearTimeout(p.timer);
        p.reject(new Error('[veil/transport] session closed'));
      }
    }
    this.pendingSends.clear();
    this.stopHeartbeat();
    this.cleanupSocket();
    this.reconnectPolicy.reset();
    this.setStatus('disconnected');
  }

  private cleanupSocket(): void {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.serverNonce = null;
  }

  private scheduleReconnect(): void {
    if (this.isDisposed || this.reconnectTimer) return;
    const delay = this.reconnectPolicy.nextDelay();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isDisposed) {
        this.connect();
      }
    }, delay);
  }

  private sendFrame(frame: any): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private handleMessage(raw: string): void {
    const frame = RelayProtocol.parseServerFrame(raw);
    if (!frame) return;

    switch (frame.t) {
      case 'HELLO':
        try {
          this.serverNonce = fromB64(frame.nonce);
          this.setStatus('connected');
          this.reconnectPolicy.reset();
          this.startHeartbeat();
          this.resubscribeAll();
        } catch {
          this.disconnect();
        }
        break;

      case 'SUBBED':
        // Inbox subscription confirmed
        break;

      case 'DENIED':
        this.scheduleDeniedRetry(frame.inbox);
        break;

      case 'DELIVER':
        this.handleDeliver(frame.inbox, frame.id, frame.env);
        break;

      case 'ACCEPTED': {
        const queue = this.pendingSends.get(frame.inbox);
        if (queue && queue.length > 0) {
          const item = queue.shift()!;
          clearTimeout(item.timer);
          item.resolve(frame.id);
        }
        break;
      }

      case 'DROPPED': {
        const queue = this.pendingSends.get(frame.inbox);
        if (queue && queue.length > 0) {
          const item = queue.shift()!;
          clearTimeout(item.timer);
          item.reject(new Error('[veil/relay] message dropped by relay: queue full'));
        }
        break;
      }

      case 'PONG':
        break;

      case 'ERR':
        break;
    }
  }

  private handleDeliver(inbox: string, id: string, envBase64: string): void {
    // Not ours (any more): leave it at the relay.
    const sub = this.subscriptions.get(inbox);
    if (!sub) return;

    if (typeof envBase64 !== 'string') {
      // Malformed forever; drop it so it is not redelivered on every SUB.
      this.sendFrame(RelayProtocol.createAck(inbox, [id]));
      return;
    }

    let handled = false;
    try {
      handled = sub.onDeliver(envBase64, id) === true;
    } catch {
      handled = false;
    }
    if (handled) this.sendFrame(RelayProtocol.createAck(inbox, [id]));
  }

  private scheduleDeniedRetry(inbox: string): void {
    if (!this.subscriptions.has(inbox) || this.deniedRetryTimers.has(inbox)) return;
    const timer = setTimeout(() => {
      this.deniedRetryTimers.delete(inbox);
      this.queueSub(inbox);
    }, DENIED_RETRY_MS);
    this.deniedRetryTimers.set(inbox, timer);
  }

  private resubscribeAll(): void {
    if (!this.serverNonce || this.status !== 'connected') return;
    for (const inbox of this.subscriptions.keys()) this.queueSub(inbox);
  }

  private queueSub(inbox: string): void {
    if (!this.subscriptions.has(inbox)) return;
    this.subQueue.add(inbox);
    if (this.subTimer) return;
    this.subTimer = setInterval(() => this.drainSubQueue(), SUB_INTERVAL_MS);
    this.drainSubQueue();
  }

  private drainSubQueue(): void {
    if (!this.serverNonce || this.status !== 'connected') {
      this.stopSubQueue(false);
      return;
    }
    const next = this.subQueue.values().next();
    if (next.done) {
      this.stopSubQueue(false);
      return;
    }
    const inbox = next.value;
    this.subQueue.delete(inbox);
    const sub = this.subscriptions.get(inbox);
    if (!sub) return;
    const auth = signInboxAuth(sub.signer, inbox, this.serverNonce);
    this.sendFrame(RelayProtocol.createSub(inbox, auth.signPk, auth.signature));
  }

  private stopSubQueue(clear = true): void {
    if (this.subTimer) clearInterval(this.subTimer);
    this.subTimer = null;
    if (clear) this.subQueue.clear();
  }

  /**
   * Subscribes to an inbox. `signer` is the inbox's own claim key (wire v2),
   * never an identity key, so the relay cannot link inboxes to a person.
   */
  public subscribe(inbox: string, signer: InboxSigner, onDeliver: DeliverCallback): () => void {
    this.subscriptions.set(inbox, { signer, onDeliver });
    if (this.status === 'connected' && this.serverNonce) {
      this.queueSub(inbox);
    } else if (this.status === 'disconnected') {
      this.connect();
    }

    return () => {
      this.unsubscribe(inbox);
    };
  }

  public unsubscribe(inbox: string): void {
    this.subscriptions.delete(inbox);
    this.subQueue.delete(inbox);
    const retry = this.deniedRetryTimers.get(inbox);
    if (retry) clearTimeout(retry);
    this.deniedRetryTimers.delete(inbox);
    if (this.status === 'connected') {
      this.sendFrame(RelayProtocol.createUnsub(inbox));
    }
  }

  public async sendEnvelope(
    inbox: string,
    base64Envelope: string,
    timeoutMs = 10_000,
  ): Promise<string> {
    if (this.status !== 'connected') {
      this.connect();
      throw new Error('[veil/transport] relay is not connected');
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.pendingSends.get(inbox);
        if (queue) {
          const idx = queue.findIndex((p) => p.timer === timer);
          if (idx !== -1) queue.splice(idx, 1);
        }
        reject(new Error('[veil/transport] send envelope timed out waiting for relay ACCEPTED'));
      }, timeoutMs);

      let queue = this.pendingSends.get(inbox);
      if (!queue) {
        queue = [];
        this.pendingSends.set(inbox, queue);
      }
      queue.push({ resolve, reject, timer });

      const ok = this.sendFrame(RelayProtocol.createSend(inbox, base64Envelope));
      if (!ok) {
        clearTimeout(timer);
        const idx = queue.findIndex((p) => p.timer === timer);
        if (idx !== -1) queue.splice(idx, 1);
        reject(new Error('[veil/transport] socket write failed'));
      }
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendFrame(RelayProtocol.createPing());
    }, 20_000);

    // Periodic NOOP cover traffic
    this.noopTimer = setInterval(() => {
      this.sendFrame(RelayProtocol.createNoop());
    }, 45_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.noopTimer) clearInterval(this.noopTimer);
    this.heartbeatTimer = null;
    this.noopTimer = null;
  }
}

export const relayClient = new RelayClient();
export default relayClient;
