/**
 * ============================================================================
 *  VEIL — COMPLETE MESSAGE SERVICE & PIPELINE ORCHESTRATION
 * ============================================================================
 *  Orchestrates the end-to-end messaging pipeline:
 *
 *    Outbound:
 *      Composer -> MessageService -> Local Storage (Vault / RamVault)
 *      -> RatchetManager (AEAD encrypt) -> EnvelopeCodec (4096-byte pad)
 *      -> RelayClient (SEND) -> Relay ACK -> markDelivered()
 *
 *    Inbound:
 *      Relay (DELIVER) -> RelayClient (instant ACK) -> EnvelopeCodec (unpad)
 *      -> RatchetManager (AEAD decrypt) -> Local Storage (Vault / RamVault)
 *      -> UI Notification
 *
 *  Ensures:
 *   - No UI component directly performs cryptography.
 *   - No UI component manages WebSocket protocol frames.
 *   - No relay module sees or decrypts message content.
 * ============================================================================
 */

import {
  blindedInboxId,
  inboxWindow,
  fromB64,
  type MaskIdentity,
} from '../crypto/keys';
import {
  insertMessage,
  markDelivered,
  type StoredMessage,
} from '../storage/db';
import { contactManager } from '../protocol/contacts/ContactManager';
import { EnvelopeCodec } from '../transport/EnvelopeCodec';
import { relayClient, RelayClient } from '../transport/RelayClient';
import type { Contact, RetentionMode, WireEnvelope } from '../types/models';
import { ratchetManager, RatchetManager } from './RatchetManager';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (s: string) => encoder.encode(s);
const fromUtf8 = (b: Uint8Array) => decoder.decode(b);

export type MessageListener = (msg: StoredMessage) => void;

export class MessageService {
  private relay: RelayClient;
  private ratchets: RatchetManager;
  private messageListeners = new Set<MessageListener>();
  private unsubscribeInboxes: Array<() => void> = [];
  private activeMask: MaskIdentity | null = null;

  constructor(relay: RelayClient = relayClient, ratchets: RatchetManager = ratchetManager) {
    this.relay = relay;
    this.ratchets = ratchets;
  }

  public setActiveMask(mask: MaskIdentity | null): void {
    this.activeMask = mask;
    this.refreshSubscriptions();
  }

  public onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  private notifyListeners(msg: StoredMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(msg);
      } catch {
        /* listener error */
      }
    }
  }

  /**
   * Refreshes relay subscriptions across the current hourly epoch window (hour-1, hour, hour+1).
   */
  public refreshSubscriptions(): void {
    // Unsubscribe previous inboxes
    for (const unsub of this.unsubscribeInboxes) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    this.unsubscribeInboxes = [];

    if (!this.activeMask) return;

    // Subscribe to current inbox window for our mask's DH key
    const inboxes = inboxWindow(this.activeMask.dhPk);
    for (const inbox of inboxes) {
      const unsub = this.relay.subscribe(inbox, this.activeMask, (envelope, rawId) => {
        this.handleInboundEnvelope(envelope, rawId);
      });
      this.unsubscribeInboxes.push(unsub);
    }
  }

  /**
   * Sends an outbound message through the complete cryptographic pipeline.
   */
  public async sendMessage(params: {
    threadId: string;
    contact: Contact;
    body: string;
    retention: RetentionMode;
    ttlMs?: number;
    senderFp: string;
    msgId?: string;
  }): Promise<StoredMessage> {
    const { threadId, contact, body, retention, ttlMs, senderFp } = params;
    const msgId =
      params.msgId ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // 1. Store locally in vault (persistent/timed) or RamVault (viewOnce)
    const stored = insertMessage({
      id: msgId,
      threadId,
      direction: 'out',
      retention,
      body,
      ttlMs,
    });

    this.notifyListeners(stored);

    // 2. Derive symmetrical conversation ID for AAD binding
    const conversationId = [senderFp, contact.fingerprint].sort().join(':');

    // 3. Encrypt payload with Double Ratchet
    const encrypted = this.ratchets.encrypt(
      threadId,
      utf8(body),
      retention,
      senderFp,
      msgId,
      contact,
      ttlMs,
      conversationId,
    );

    // 4. Target recipient's blinded inbox address for current epoch
    const targetInbox = blindedInboxId(contact.dhPk);

    // 5. Encode and pad to uniform 4,096 bytes
    const paddedEnvelope = EnvelopeCodec.encode({
      inbox: targetInbox,
      header: encrypted.header,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
      id: msgId,
    });

    // 6. Dispatch across blind relay and wait for acceptance
    try {
      await this.relay.sendEnvelope(targetInbox, paddedEnvelope);
      markDelivered(msgId);
      stored.delivered_at = Date.now();
    } catch {
      // Message queued locally; failure indicated on bubble rather than modal alert
    }

    return stored;
  }

  /**
   * Processes inbound envelopes delivered by the relay.
   */
  public handleInboundEnvelope(envelope: WireEnvelope, rawId: string): void {
    if (!this.activeMask) return;

    let remoteDhPk: Uint8Array;
    let nonce: Uint8Array;
    let ciphertext: Uint8Array;
    try {
      remoteDhPk = fromB64(envelope.header.dhPk);
      nonce = fromB64(envelope.nonce);
      ciphertext = fromB64(envelope.ciphertext);
    } catch {
      return;
    }

    // 1. Identify contact via header.senderFp if present, or fallback to matching known contacts
    const senderFp = envelope.header.senderFp;
    let contact: Contact | null = null;
    if (senderFp) {
      contact = contactManager.getContactByFingerprint(senderFp);
    }

    if (!contact) {
      const contacts = contactManager.listContacts();
      contact =
        contacts.find((c) => {
          const state = this.ratchets.getOrLoadRatchet(`th_${c.id}`);
          return (
            c.dhPk.every((b, i) => b === remoteDhPk[i]) ||
            (state?.remoteDhPk && state.remoteDhPk.every((b, i) => b === remoteDhPk[i]))
          );
        }) ?? null;
    }

    // If contact still unknown, create an auto-discovered contact record
    if (!contact) {
      const alias = senderFp ? `Peer ${senderFp.slice(0, 4)}` : `Peer ${envelope.header.dhPk.slice(0, 4)}`;
      contact = contactManager.saveContact({
        maskIndex: this.activeMask.index,
        alias,
        signPk: remoteDhPk,
        dhPk: remoteDhPk,
        verified: false,
      });
    }

    const threadId = `th_${contact.id}`;
    const effectiveSenderFp = senderFp ?? contact.fingerprint;
    const conversationId = [effectiveSenderFp, this.activeMask.fingerprint].sort().join(':');

    // Decrypt payload with Double Ratchet using symmetric conversationId
    const pt = this.ratchets.decrypt(
      threadId,
      {
        header: envelope.header,
        nonce,
        ciphertext,
      },
      effectiveSenderFp,
      this.activeMask,
      remoteDhPk,
      conversationId,
    );

    if (!pt) {
      // Discard unreadable or tampered envelope
      return;
    }

    const bodyText = fromUtf8(pt);

    // Store in Vault (persistent/timed) or RamVault (viewOnce)
    const stored = insertMessage({
      id: envelope.header.msgId || rawId,
      threadId,
      direction: 'in',
      retention: envelope.header.retention,
      body: bodyText,
      ttlMs: envelope.header.ttlMs,
      counter: envelope.header.n,
    });

    this.notifyListeners(stored);
  }
}

export const messageService = new MessageService();
export default messageService;
