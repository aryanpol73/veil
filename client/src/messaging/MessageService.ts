/**
 * ============================================================================
 *  VEIL — COMPLETE MESSAGE SERVICE & PIPELINE ORCHESTRATION (wire v2)
 * ============================================================================
 *  Orchestrates the end-to-end messaging pipeline:
 *
 *    Outbound:
 *      Composer -> MessageService -> RatchetManager (body AEAD)
 *      -> SealedEnvelope (header + padding under the inbox's header key)
 *      -> Local Storage (Vault / RamVault) -> RelayClient (SEND) -> ACCEPTED
 *
 *    Inbound:
 *      Relay (DELIVER) -> RelayClient -> route by inbox -> SealedEnvelope open
 *      -> RatchetManager (body AEAD) -> Local Storage, in ONE transaction
 *      -> return true -> RelayClient ACKs (relay deletes its copy)
 *
 *  Addressing (see protocol/pairing.ts):
 *    - Before a reply has been received, the initiator writes to the invite's
 *      rendezvous inbox and attaches a sealed, signed intro.
 *    - Once a session exists, each side writes to the other's pair inbox,
 *      derived from the pair secret. The relay never sees an identity key,
 *      fingerprint, ratchet header or message length.
 *
 *  Ensures:
 *   - No UI component directly performs cryptography.
 *   - No UI component manages WebSocket protocol frames.
 *   - The relay copy is only deleted after the message is durably stored.
 *   - A session is only started from a first message carrying a valid,
 *     signed initiator introduction, through a live invite of ours, and each
 *     invite admits exactly one initiator.
 * ============================================================================
 */

import { createInvite as buildInvite, fromB64, randomBytes, wipe, type MaskIdentity } from '../crypto/keys';
import {
  deleteOutbox,
  enqueueOutbox,
  insertMessage,
  isVaultOpen,
  listDueOutbox,
  listLiveInvites,
  markDelivered,
  rescheduleOutbox,
  markInviteConsumed,
  newLocalId,
  pruneInvites,
  saveInvite,
  withTransaction,
  type StoredMessage,
} from '../storage/db';
import { contactManager } from '../protocol/contacts/ContactManager';
import { createIntro, decodeInner, encodeInner, openIntro, sealIntro, verifyIntro } from '../protocol/intro';
import {
  introKeyFromRoot,
  pairHeaderKey,
  pairInboxId,
  pairInboxSigner,
  pairInboxWindow,
  pairSecretFromRoot,
  rendezvousHeaderKey,
  rendezvousInboxId,
  rendezvousSigner,
  type InboxSigner,
} from '../protocol/pairing';
import {
  initBobSession,
  ratchetDecryptMessage,
  type RatchetEncryptedPayload,
} from '../protocol/ratchet';
import {
  deserializeInner,
  openEnvelope,
  sealEnvelope,
  serializeInner,
  toWireHeader,
  type InnerEnvelope,
} from '../transport/SealedEnvelope';
import { relayClient, RelayClient } from '../transport/RelayClient';
import type { Contact, RetentionMode } from '../types/models';
import { ratchetManager, RatchetManager } from './RatchetManager';

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s);

/**
 * Largest message body accepted from the composer, in UTF-8 bytes. Leaves
 * headroom inside the sealed envelope for the header, intro and base64
 * expansion, so an accepted message can always be encoded.
 */
export const MAX_MESSAGE_BYTES = 2000;

const RETENTION_MODES: RetentionMode[] = ['persistent', 'timed', 'viewOnce'];

/** Subscriptions are refreshed this often so pair-inbox epochs roll over. */
const REFRESH_MS = 15 * 60_000;

/** Outbox polling and retry backoff. */
const OUTBOX_POLL_MS = 15_000;
const OUTBOX_RETRY_BASE_MS = 2_000;
const OUTBOX_RETRY_MAX_MS = 5 * 60_000;

export class MessageTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`[veil/messaging] message is ${bytes} bytes; limit is ${MAX_MESSAGE_BYTES}`);
  }
}

/**
 * Thrown when sending to a contact whose keys changed and the user has not
 * reviewed the change yet (audit A-11, feature F-08 AC 3).
 */
export class IdentityChangedError extends Error {
  constructor() {
    super('[veil/messaging] contact keys changed; review the safety number before sending');
  }
}

export type MessageListener = (msg: StoredMessage) => void;

export const threadIdFor = (contact: Pick<Contact, 'id'>): string => `th_${contact.id}`;

const conversationIdFor = (a: string, b: string): string => [a, b].sort().join(':');

type Route =
  | { kind: 'pair'; contactId: string; headerKey: Uint8Array }
  | { kind: 'rendezvous'; inviteId: string; headerKey: Uint8Array; consumedFp: string | null };

export class MessageService {
  private relay: RelayClient;
  private ratchets: RatchetManager;
  private messageListeners = new Set<MessageListener>();
  private subscribed = new Map<string, () => void>();
  private routes = new Map<string, Route>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private statusUnsub: (() => void) | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private activeMask: MaskIdentity | null = null;

  constructor(relay: RelayClient = relayClient, ratchets: RatchetManager = ratchetManager) {
    this.relay = relay;
    this.ratchets = ratchets;
  }

  /** Binds the service to an unlocked identity, or detaches it on lock (null). */
  public setActiveMask(mask: MaskIdentity | null): void {
    this.activeMask = mask;
    if (mask) pruneInvites();
    this.refreshSubscriptions();

    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.refreshTimer = null;
    this.outboxTimer = null;
    this.statusUnsub?.();
    this.statusUnsub = null;
    if (!mask) return;

    const unref = (t: ReturnType<typeof setInterval>) => {
      (t as { unref?: () => void }).unref?.();
      return t;
    };
    this.refreshTimer = unref(setInterval(() => this.refreshSubscriptions(), REFRESH_MS));
    this.outboxTimer = unref(setInterval(() => void this.flushOutbox(), OUTBOX_POLL_MS));
    // Anything queued while offline goes out as soon as the relay is back.
    this.statusUnsub = this.relay.onStatusChange((status) => {
      if (status === 'connected') void this.flushOutbox(true);
    });
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
   * Issues an invite and starts watching its rendezvous inbox. The claim key
   * for that inbox comes from a private seed kept in the vault, so holders of
   * the invite can write to the inbox but cannot claim it.
   */
  public createInvite(opts: { ttlSeconds?: number; nick?: string } = {}): { uri: string; expiresAt: number } {
    const mask = this.activeMask;
    if (!mask) throw new Error('[veil/messaging] no active identity');
    const { uri, rendezvous, expiresAt } = buildInvite(mask, opts);
    saveInvite({ id: newLocalId('inv'), rz: rendezvous, authSeed: randomBytes(32), expiresAt });
    this.refreshSubscriptions();
    return { uri, expiresAt };
  }

  /**
   * Brings relay subscriptions in line with what this vault should receive:
   * every contact's pair-inbox window and every live invite's rendezvous
   * inbox. Only the difference is (un)subscribed.
   */
  public refreshSubscriptions(): void {
    const mask = this.activeMask;
    const wanted = new Map<string, { route: Route; signer: InboxSigner }>();

    if (mask && isVaultOpen()) {
      for (const contact of contactManager.listContacts()) {
        const secret = contact.pairSecret;
        if (!secret) continue;
        const headerKey = pairHeaderKey(secret, mask.signPk);
        for (const inbox of pairInboxWindow(secret, mask.signPk)) {
          wanted.set(inbox, {
            route: { kind: 'pair', contactId: contact.id, headerKey },
            signer: pairInboxSigner(secret, inbox),
          });
        }
      }
      for (const invite of listLiveInvites()) {
        wanted.set(rendezvousInboxId(invite.rz), {
          route: {
            kind: 'rendezvous',
            inviteId: invite.id,
            headerKey: rendezvousHeaderKey(invite.rz),
            consumedFp: invite.consumedFp,
          },
          signer: rendezvousSigner(invite.authSeed),
        });
      }
    }

    for (const [inbox, unsub] of this.subscribed) {
      if (wanted.has(inbox)) continue;
      try {
        unsub();
      } catch {
        /* ignore */
      }
      this.subscribed.delete(inbox);
    }

    this.routes = new Map([...wanted].map(([inbox, w]) => [inbox, w.route]));
    for (const [inbox, { signer }] of wanted) {
      if (this.subscribed.has(inbox)) continue;
      const unsub = this.relay.subscribe(inbox, signer, (env) => this.handleInbound(inbox, env));
      this.subscribed.set(inbox, unsub);
    }
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
    const { threadId, retention, ttlMs, senderFp, body } = params;
    let contact = params.contact;
    const mask = this.activeMask;
    if (!mask) throw new Error('[veil/messaging] no active identity');

    // Re-read: the caller's copy may predate a key change.
    const current = contactManager.getContact(contact.id);
    if ((current ?? contact).verificationState === 'CHANGED_IDENTITY') {
      throw new IdentityChangedError();
    }

    const bodyBytes = utf8(body).length;
    if (bodyBytes > MAX_MESSAGE_BYTES) throw new MessageTooLargeError(bodyBytes);

    const msgId = params.msgId ?? newLocalId('m');
    const state = this.ratchets.ensureOutgoingSession(threadId, contact);
    const replied = this.ratchets.hasReceived(threadId);

    // Before any reply, the root key is still the session's initial one, so
    // both the pair secret and the intro key can be derived from it here.
    let introKey: Uint8Array | null = null;
    if (!replied) {
      introKey = introKeyFromRoot(state.rootKey);
      if (!contact.pairSecret) {
        const secret = pairSecretFromRoot(state.rootKey);
        contactManager.setPairSecret(contact.id, secret);
        contact = { ...contact, pairSecret: secret };
        this.refreshSubscriptions(); // start listening for the reply
      }
    }
    if (!contact.pairSecret) throw new Error('[veil/messaging] session has no pair secret');

    const encrypted = this.ratchets.encrypt(
      threadId,
      encodeInner({ body }),
      retention,
      senderFp,
      msgId,
      contact,
      ttlMs,
      conversationIdFor(senderFp, contact.fingerprint),
    );
    const header = toWireHeader(encrypted.header);

    const inner: InnerEnvelope = {
      header,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
    };
    if (introKey) {
      const intro = createIntro(mask, state.localDhPk, contact.signPk, contact.dhPk);
      inner.intro = sealIntro(intro, introKey, header.dhPk);
      wipe(introKey);
    }
    // Fail now, before storing, if the envelope cannot be built.
    const route = this.routeFor(threadId, contact)!;
    sealEnvelope(route.headerKey, route.inbox, inner);

    // The local copy and its outbox entry commit together, so a crash can
    // neither lose a queued message nor leave a phantom "sent" one.
    let stored!: StoredMessage;
    withTransaction(() => {
      stored = insertMessage({ id: msgId, threadId, direction: 'out', retention, body, ttlMs });
      enqueueOutbox({ id: msgId, threadId, contactId: contact.id, inner: serializeInner(inner) });
    });
    this.notifyListeners(stored);

    const delivered = await this.flushOutbox();
    if (delivered.has(msgId)) stored.delivered_at = Date.now();
    return stored;
  }

  /** Current inbox and header key for mail to `contact`, or null without a session. */
  private routeFor(
    threadId: string,
    contact: Contact,
  ): { inbox: string; headerKey: Uint8Array } | null {
    if (!contact.pairSecret) return null;
    // Until the peer has replied, write through the invite's rendezvous inbox.
    if (contact.rendezvous && !this.ratchets.hasReceived(threadId)) {
      return {
        inbox: rendezvousInboxId(contact.rendezvous),
        headerKey: rendezvousHeaderKey(contact.rendezvous),
      };
    }
    return {
      inbox: pairInboxId(contact.pairSecret, contact.signPk),
      headerKey: pairHeaderKey(contact.pairSecret, contact.signPk),
    };
  }

  /**
   * Sends every due outbox item. Runs one at a time (calls are chained), and
   * resolves with the IDs the relay accepted during this run. `force` ignores
   * backoff, e.g. right after reconnecting.
   */
  public flushOutbox(force = false): Promise<Set<string>> {
    const run = this.flushChain.then(() => this.flushOnce(force));
    this.flushChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flushOnce(force: boolean): Promise<Set<string>> {
    const delivered = new Set<string>();
    if (!this.activeMask || !isVaultOpen()) return delivered;

    for (const item of listDueOutbox(force ? Number.MAX_SAFE_INTEGER : Date.now())) {
      if (!this.activeMask || !isVaultOpen()) break;
      const contact = contactManager.getContact(item.contactId);
      const inner = deserializeInner(item.inner);
      const route = contact ? this.routeFor(item.threadId, contact) : null;
      if (!contact || !inner || !route) {
        deleteOutbox(item.id); // the conversation is gone; nothing to retry
        continue;
      }
      try {
        // Sealed afresh per attempt: a late retry targets the current epoch.
        await this.relay.sendEnvelope(route.inbox, sealEnvelope(route.headerKey, route.inbox, inner));
        withTransaction(() => {
          deleteOutbox(item.id);
          markDelivered(item.id);
        });
        delivered.add(item.id);
      } catch {
        const attempts = item.attempts + 1;
        const backoff = Math.min(OUTBOX_RETRY_MAX_MS, OUTBOX_RETRY_BASE_MS * 2 ** (attempts - 1));
        rescheduleOutbox(item.id, attempts, Date.now() + backoff);
      }
    }
    return delivered;
  }

  /**
   * Processes an envelope that arrived on `inbox`. Returns true when the relay
   * copy may be deleted: the message was committed, or it can never be
   * processed (forged, malformed, not for us). Returns false to leave it at
   * the relay, e.g. when the vault is locked or the local write failed.
   */
  public handleInbound(inbox: string, envelopeB64: string): boolean {
    const mask = this.activeMask;
    if (!mask || !isVaultOpen()) return false;
    const route = this.routes.get(inbox);
    if (!route) return false;

    const inner = openEnvelope(route.headerKey, inbox, envelopeB64);
    if (!inner || !RETENTION_MODES.includes(inner.header.retention)) return true;

    let remoteDhPk: Uint8Array;
    try {
      remoteDhPk = fromB64(inner.header.dhPk);
    } catch {
      return true;
    }
    if (remoteDhPk.length !== 32) return true;

    const payload: RatchetEncryptedPayload = {
      header: inner.header,
      nonce: inner.nonce,
      ciphertext: inner.ciphertext,
    };

    if (route.kind === 'pair') {
      const contact = contactManager.getContact(route.contactId);
      if (!contact || !this.ratchets.getOrLoadRatchet(threadIdFor(contact))) return true;
      return this.receiveOnSession(contact, payload, contact.fingerprint, mask, remoteDhPk);
    }
    return this.receiveViaRendezvous(route, inner, payload, mask, remoteDhPk);
  }

  private receiveOnSession(
    contact: Contact,
    payload: RatchetEncryptedPayload,
    senderFp: string,
    mask: MaskIdentity,
    remoteDhPk: Uint8Array,
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
          conversationIdFor(senderFp, mask.fingerprint),
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
   * A message on one of our invites' rendezvous inboxes. Accepted only with
   * an intro that opens under this session's key, verifies against the
   * initiator's identity key, and comes from the invite's one initiator.
   */
  private receiveViaRendezvous(
    route: Extract<Route, { kind: 'rendezvous' }>,
    inner: InnerEnvelope,
    payload: RatchetEncryptedPayload,
    mask: MaskIdentity,
    remoteDhPk: Uint8Array,
  ): boolean {
    if (!inner.intro) return true;

    const state = initBobSession(mask.dhSk, mask.dhPk, remoteDhPk);
    const introKey = introKeyFromRoot(state.rootKey);
    const intro = openIntro(inner.intro, introKey, inner.header.dhPk);
    wipe(introKey);
    if (!intro) return true;
    const fp = verifyIntro(intro, remoteDhPk, mask);
    if (!fp) return true;

    // Single use: once an invite has paired, it admits no other initiator.
    if (route.consumedFp && route.consumedFp !== fp) return true;

    const known = contactManager.getContactBySignPk(intro.ik);
    if (known && known.fingerprint !== fp) return true; // same identity, other keys
    if (known && this.ratchets.getOrLoadRatchet(threadIdFor(known))) {
      // A later message the initiator sent before seeing our reply.
      return this.receiveOnSession(known, payload, fp, mask, remoteDhPk);
    }

    const pairSecret = pairSecretFromRoot(state.rootKey);
    const pt = ratchetDecryptMessage({
      state,
      payload,
      threadId: conversationIdFor(fp, mask.fingerprint),
      senderFp: fp,
    });
    if (!pt) return true;
    const body = decodeInner(pt);
    wipe(pt);
    if (!body) return true;

    let threadId: string | null = null;
    let stored: StoredMessage | null = null;
    try {
      withTransaction(() => {
        const contact = contactManager.saveContact({
          id: known?.id,
          maskIndex: mask.index,
          alias: known?.alias ?? `Peer ${fp.slice(0, 4)}`,
          signPk: intro.ik,
          dhPk: intro.xk,
          pairSecret,
        });
        threadId = threadIdFor(contact);
        contactManager.ensureThread(contact);
        this.ratchets.adoptSession(threadId, state);
        if (!route.consumedFp) markInviteConsumed(route.inviteId, fp);
        stored = this.storeInbound(threadId, payload, body.body);
      });
    } catch {
      if (threadId) this.ratchets.purge(threadId);
      return false;
    }
    // Start listening on the new pair inbox, and pin the invite to this initiator.
    this.refreshSubscriptions();
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
