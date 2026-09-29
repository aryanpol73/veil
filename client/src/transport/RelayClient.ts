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

import { fromB64, signInboxAuth, type MaskIdentity } from '../crypto/keys';
import type { ServerFrame, WireEnvelope } from '../types/models';
import { EnvelopeCodec } from './EnvelopeCodec';
import { ReconnectPolicy } from './ReconnectPolicy';
import { RelayProtocol } from './RelayProtocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface RelayClientConfig {
  url?: string;
  heartbeatMs?: number;
  noopIntervalMs?: number;
  sendTimeoutMs?: number;
}

export type DeliverCallback = (envelope: WireEnvelope, rawId: string) => void;

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

  private subscriptions = new Map<
    string,
    { mask: MaskIdentity; onDeliver: DeliverCallback }
  >();

  private pendingSends = new Map<string, PendingSend[]>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();

  constructor(config: RelayClientConfig = {}) {
    this.url =
      config.url ??
      (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_RELAY_URL
        ? process.env.EXPO_PUBLIC_RELAY_URL
        : 'ws://127.0.0.1:8443');
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
    if (this.isDisposed || this.ws) return;
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

  public disconnect(): void {
    this.isDisposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.cleanupSocket();
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
        // Inbox subscription was denied by relay
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
    // 1. Immediately ACK receipt to delete envelope from server RAM
    this.sendFrame(RelayProtocol.createAck(inbox, [id]));

    // 2. Decode envelope
    const envelope = EnvelopeCodec.decode(envBase64);
    if (!envelope) return;

    // 3. Dispatch to inbox listener
    const sub = this.subscriptions.get(inbox);
    if (sub) {
      try {
        sub.onDeliver(envelope, id);
      } catch {
        /* listener error */
      }
    }
  }

  private resubscribeAll(): void {
    if (!this.serverNonce || this.status !== 'connected') return;
    for (const [inbox, { mask }] of this.subscriptions) {
      const auth = signInboxAuth(mask, inbox, this.serverNonce);
      this.sendFrame(RelayProtocol.createSub(inbox, auth.signPk, auth.signature));
    }
  }

  public subscribe(
    inbox: string,
    mask: MaskIdentity,
    onDeliver: DeliverCallback,
  ): () => void {
    this.subscriptions.set(inbox, { mask, onDeliver });
    if (this.status === 'connected' && this.serverNonce) {
      const auth = signInboxAuth(mask, inbox, this.serverNonce);
      this.sendFrame(RelayProtocol.createSub(inbox, auth.signPk, auth.signature));
    } else if (this.status === 'disconnected') {
      this.connect();
    }

    return () => {
      this.unsubscribe(inbox);
    };
  }

  public unsubscribe(inbox: string): void {
    this.subscriptions.delete(inbox);
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
