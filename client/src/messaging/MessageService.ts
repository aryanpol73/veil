/**
 * ============================================================================
 *  VEIL — COMPLETE MESSAGE SERVICE & PIPELINE ORCHESTRATION
 * ============================================================================
 *  Orchestrates the end-to-end messaging pipeline:
 *
 *    Outbound:
 *      Composer -> MessageService -> RatchetManager (AEAD encrypt)
 *      -> EnvelopeCodec (4096-byte pad) -> Local Storage (Vault / RamVault)
 *      -> RelayClient (SEND) -> Relay ACCEPTED -> markDelivered()
 *
 *    Inbound:
 *      Relay (DELIVER) -> RelayClient -> EnvelopeCodec (unpad)
 *      -> RatchetManager (AEAD decrypt) -> Local Storage, in ONE transaction
 *      -> return true -> RelayClient ACKs (relay deletes its copy)
 *
 *  Ensures:
 *   - No UI component directly performs cryptography.
 *   - No UI component manages WebSocket protocol frames.
 *   - No relay module sees or decrypts message content.
 *   - The relay copy is only deleted after the message is durably stored.
 *   - A session is only started from a first message carrying a valid,
 *     signed initiator introduction (see protocol/intro.ts).
 * ============================================================================
 */

import {
  blindedInboxId,
  inboxCatchUpWindow,
  fromB64,
  wipe,
  type MaskIdentity,
} from '../crypto/keys';
import {
  insertMessage,
  isVaultOpen,
  markDelivered,
  newLocalId,
  withTransaction,
  type StoredMessage,
} from '../storage/db';
import { contactManager } from '../protocol/contacts/ContactManager';
import { createIntro, decodeInner, encodeInner, verifyIntro } from '../protocol/intro';
import {
  initBobSession,
  ratchetDecryptMessage,
  type RatchetEncryptedPayload,
} from '../protocol/ratchet';
import { EnvelopeCodec } from '../transport/EnvelopeCodec';
import { relayClient, RelayClient } from '../transport/RelayClient';
import type { Contact, RetentionMode, WireEnvelope } from '../types/models';
import { ratchetManager, RatchetManager } from './RatchetManager';

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);

/**
 * Largest message body accepted from the composer, in UTF-8 bytes. Leaves
 * headroom inside the 4096-byte envelope for the header, intro and base64
 * expansion, so an accepted message can always be encoded.
 */
export const MAX_MESSAGE_BYTES = 2000;

const RETENTION_MODES: RetentionMode[] = ['persistent', 'timed', 'viewOnce'];
const HOUR_MS = 3_600_000;

export class MessageTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`[veil/messaging] message is ${bytes} bytes; limit is ${MAX_MESSAGE_BYTES}`);
  }
}

export type MessageListener = (msg: StoredMessage) => void;

export const threadIdFor = (contact: Pick<Contact, 'id'>): string => `th_${contact.id}`;

const conversationIdFor = (a: string, b: string): string => [a, b].sort().join(':');

export class MessageService {
  private relay: RelayClient;
  private ratchets: RatchetManager;
  private messageListeners = new Set<MessageListener>();
  private subscribed = new Map<string, () => void>();
  private epochTimer: ReturnType<typeof setTimeout> | null = null;
  private activeMask: MaskIdentity | null = null;

  constructor(relay: RelayClient = relayClient, ratchets: RatchetManager = ratchetManager) {
    this.relay = relay;
    this.ratchets = ratchets;
  }

  /** Binds the service to an unlocked identity, or detaches it on lock (null). */
  public setActiveMask(mask: MaskIdentity | null): void {
    this.activeMask = mask;
    this.refreshSubscriptions();
    this.scheduleEpochRefresh();
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
   * Brings relay subscriptions in line with the current catch-up window
   * (last 24 epochs, current, next). Only the difference is (un)subscribed.
   */
  public refreshSubscriptions(): void {
    const wanted = new Set(this.activeMask ? inboxCatchUpWindow(this.activeMask.dhPk) : []);

    for (const [inbox, unsub] of this.subscribed) {
      if (wanted.has(inbox)) continue;
      try {
        unsub();
      } catch {
        /* ignore */
      }
      this.subscribed.delete(inbox);
    }

    const mask = this.activeMask;
    if (!mask) return;
    for (const inbox of wanted) {
      if (this.subscribed.has(inbox)) continue;
      const unsub = this.relay.subscribe(inbox, mask, (envelope, rawId) =>
        this.handleInboundEnvelope(envelope, rawId),
      );
      this.subscribed.set(inbox, unsub);
    }
  }

  /** Re-runs refreshSubscriptions just after every epoch-hour boundary. */
  private scheduleEpochRefresh(): void {
    if (this.epochTimer) clearTimeout(this.epochTimer);
    this.epochTimer = null;
    if (!this.activeMask) return;

    const delay = HOUR_MS - (Date.now() % HOUR_MS) + 1_000;
    const timer = setTimeout(() => {
      this.refreshSubscriptions();
      this.scheduleEpochRefresh();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.epochTimer = timer;
  }

  /**
   * Sends an outbound message through the complete cryptographic pipeline.
   * Throws MessageTooLargeError before anything is stored or sent.
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
    const mask = this.activeMask;
    if (!mask) throw new Error('[veil/messaging] no active identity');

    const bodyBytes = utf8(body).length;
    if (bodyBytes > MAX_MESSAGE_BYTES) throw new MessageTooLargeError(bodyBytes);

    const msgId = params.msgId ?? newLocalId('m');

    // 1. Until the peer has replied, introduce ourselves inside the ciphertext
    //    so they can authenticate us and route replies to our inbox.
    const state = this.ratchets.ensureOutgoingSession(threadId, contact);
    const intro = this.ratchets.hasReceived(threadId)
      ? undefined
      : createIntro(mask, state.localDhPk, contact.signPk, contact.dhPk);

    // 2. Encrypt with the Double Ratchet, binding the symmetric conversation ID.
    const encrypted = this.ratchets.encrypt(
      threadId,
      encodeInner({ body, intro }),
      retention,
      senderFp,
      msgId,
      contact,
      ttlMs,
      conversationIdFor(senderFp, contact.fingerprint),
    );

    // 3. Encode and pad to uniform 4,096 bytes for the recipient's current inbox.
    const targetInbox = blindedInboxId(contact.dhPk);
    const paddedEnvelope = EnvelopeCodec.encode({
      inbox: targetInbox,
      header: encrypted.header,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
      id: msgId,
    });

    // 4. Store locally only once the message is known to be encodable.
    const stored = insertMessage({
      id: msgId,
      threadId,
      direction: 'out',
      retention,
      body,
      ttlMs,
    });
    this.notifyListeners(stored);

    // 5. Dispatch across the blind relay and wait for acceptance.
    try {
      await this.relay.sendEnvelope(targetInbox, paddedEnvelope);
      markDelivered(msgId);
      stored.delivered_at = Date.now();
    } catch {
      // Not accepted by the relay; the bubble shows it as undelivered.
    }

    return stored;
  }

  /**
   * Processes an inbound envelope. Returns true when the relay copy may be
   * deleted: the message was committed, or it can never be processed (forged,
   * malformed, not for us). Returns false to leave it at the relay, e.g. when
   * the vault is locked or the local write failed.
   */
  public handleInboundEnvelope(envelope: WireEnvelope, _rawId: string): boolean {
    const mask = this.activeMask;
    if (!mask || !isVaultOpen()) return false;

    let payload: RatchetEncryptedPayload;
    let remoteDhPk: Uint8Array;
    try {
      remoteDhPk = fromB64(envelope.header.dhPk);
      payload = {
        header: envelope.header,
        nonce: fromB64(envelope.nonce),
        ciphertext: fromB64(envelope.ciphertext),
      };
    } catch {
      return true;
    }

    const senderFp = envelope.header.senderFp;
    if (!senderFp || remoteDhPk.length !== 32) return true;
    if (!RETENTION_MODES.includes(envelope.header.retention)) return true;

    const conversationId = conversationIdFor(senderFp, mask.fingerprint);
    const known = contactManager.getContactByFingerprint(senderFp);

    if (known && this.ratchets.getOrLoadRatchet(threadIdFor(known))) {
      return this.receiveOnSession(known, payload, senderFp, mask, remoteDhPk, conversationId);
    }
    return this.receiveFirstContact(known, payload, senderFp, mask, remoteDhPk, conversationId);
  }

  private receiveOnSession(
    contact: Contact,
    payload: RatchetEncryptedPayload,
    senderFp: string,
    mask: MaskIdentity,
    remoteDhPk: Uint8Array,
    conversationId: string,
  ): boolean {
    const threadId = threadIdFor(contact);
    let stored: StoredMessage | null = null;
    try {
      withTransaction(() => {
        const pt = this.ratchets.decrypt(
          threadId,
          payload,
          senderFp,
          mask,
          remoteDhPk,
          conversationId,
          false,
        );
        if (!pt) return;
        const inner = decodeInner(pt);
        wipe(pt);
        if (!inner) return;
        stored = this.storeInbound(threadId, payload, inner.body);
      });
    } catch {
      // Roll the in-memory ratchet back to the last committed state.
      this.ratchets.purge(threadId);
      return false;
    }
    if (stored) this.notifyListeners(stored);
    return true;
  }

  /**
   * First message of a session. Only accepted if it carries an introduction
   * signed by the initiator's identity key whose fingerprint matches the
   * claimed sender. A first message can never be grafted onto an existing
   * contact's established session.
   */
  private receiveFirstContact(
    known: Contact | null,
    payload: RatchetEncryptedPayload,
    senderFp: string,
    mask: MaskIdentity,
    remoteDhPk: Uint8Array,
    conversationId: string,
  ): boolean {
    const state = initBobSession(mask.dhSk, mask.dhPk, remoteDhPk);
    const pt = ratchetDecryptMessage({ state, payload, threadId: conversationId, senderFp });
    if (!pt) return true;
    const inner = decodeInner(pt);
    wipe(pt);
    if (!inner?.intro) return true;

    const introFp = verifyIntro(inner.intro, remoteDhPk, mask);
    if (!introFp || introFp !== senderFp) return true;

    const intro = inner.intro;
    let threadId: string | null = null;
    let stored: StoredMessage | null = null;
    try {
      withTransaction(() => {
        const contact =
          known ??
          contactManager.saveContact({
            maskIndex: mask.index,
            alias: `Peer ${introFp.slice(0, 4)}`,
            signPk: intro.ik,
            dhPk: intro.xk,
          });
        threadId = threadIdFor(contact);
        contactManager.ensureThread(contact);
        this.ratchets.adoptSession(threadId, state);
        stored = this.storeInbound(threadId, payload, inner.body);
      });
    } catch {
      if (threadId) this.ratchets.purge(threadId);
      return false;
    }
    if (stored) this.notifyListeners(stored);
    return true;
  }

  private storeInbound(
    threadId: string,
    payload: RatchetEncryptedPayload,
    body: string,
  ): StoredMessage {
    return insertMessage({
      // Local IDs never come from the wire: a peer-chosen ID could collide
      // with an existing row and make the insert fail (audit A-15).
      id: newLocalId('m'),
      threadId,
      direction: 'in',
      retention: payload.header.retention,
      body,
      ttlMs: payload.header.ttlMs,
      counter: payload.header.n,
    });
  }
}

export const messageService = new MessageService();
export default messageService;
