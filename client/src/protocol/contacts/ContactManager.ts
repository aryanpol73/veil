/**
 * ============================================================================
 *  VEIL — CONTACT & IDENTITY VERIFICATION MANAGER
 * ============================================================================
 *  Tracks cryptographic contact records. Real identities, emails, or phone
 *  numbers do not exist. Contacts are identified purely by Ed25519 identity keys,
 *  X25519 exchange keys, and human-readable Crockford Base32 fingerprints.
 *
 *  Verification states:
 *    UNVERIFIED        Default state upon import
 *    VERIFIED          Safety number verified out-of-band by user
 *    CHANGED_IDENTITY  Security alert: contact public keys changed!
 * ============================================================================
 */

import { computeFingerprint, timingSafeEqual, type ParsedInvite } from '../../crypto/keys';
import {
  getDb,
  saveContactRow,
  loadContactRow,
  newLocalId,
  loadContactRowByFingerprint,
  listContactRows,
  updateContactVerification,
  type StoredContactRecord,
} from '../../storage/db';
import type { Contact, Thread, VerificationState } from '../../types/models';

export interface CreateContactInput {
  id?: string;
  maskIndex: number;
  alias: string;
  signPk: Uint8Array;
  dhPk: Uint8Array;
  verified?: boolean;
}

const VERIFICATION_STATES: VerificationState[] = ['UNVERIFIED', 'VERIFIED', 'CHANGED_IDENTITY'];

export class ContactManager {
  /**
   * Lists all contacts in the active vault partition.
   */
  public listContacts(): Contact[] {
    const records = listContactRows();
    return records.map((r) => this.recordToContact(r));
  }

  /**
   * Retrieves a contact by their unique local ID.
   */
  public getContact(id: string): Contact | null {
    const r = loadContactRow(id);
    if (!r) return null;
    return this.recordToContact(r);
  }

  /**
   * Finds a contact by matching their cryptographic fingerprint.
   */
  public getContactByFingerprint(fingerprint: string): Contact | null {
    const r = loadContactRowByFingerprint(fingerprint);
    if (!r) return null;
    return this.recordToContact(r);
  }

  /**
   * Finds a contact by Ed25519 identity key. Contact rows are sealed, so this
   * scans the (small) decrypted list rather than querying a plaintext column.
   */
  public getContactBySignPk(signPk: Uint8Array): Contact | null {
    return this.listContacts().find((c) => timingSafeEqual(c.signPk, signPk)) ?? null;
  }

  /**
   * Creates or updates a contact. Detects key changes and triggers CHANGED_IDENTITY security event.
   */
  public saveContact(input: CreateContactInput): Contact {
    const now = Date.now();
    const fingerprint = computeFingerprint(input.signPk, input.dhPk);
    const id = input.id ?? newLocalId('ct');

    // Check for existing contact by alias or ID to detect key substitution
    const existing = this.getContact(id);
    let state: VerificationState = 'UNVERIFIED';

    if (existing) {
      const keysMatch =
        timingSafeEqual(existing.signPk, input.signPk) &&
        timingSafeEqual(existing.dhPk, input.dhPk);

      if (!keysMatch) {
        // SECURITY ALERT: remote identity changed!
        state = 'CHANGED_IDENTITY';
      } else {
        state = existing.verificationState;
      }
    } else if (input.verified) {
      state = 'VERIFIED';
    }

    const verifiedAt = state === 'VERIFIED' ? (existing?.verifiedAt ?? now) : null;

    saveContactRow({
      id,
      maskIndex: input.maskIndex,
      alias: input.alias,
      signPk: input.signPk,
      dhPk: input.dhPk,
      fingerprint,
      verifiedAt,
      createdAt: existing?.createdAt ?? now,
      verificationState: state,
    });

    return {
      id,
      maskIndex: input.maskIndex,
      alias: input.alias,
      signPk: input.signPk,
      dhPk: input.dhPk,
      fingerprint,
      verifiedAt,
      createdAt: existing?.createdAt ?? now,
      verificationState: state,
    };
  }

  /**
   * Updates verification state (e.g. user toggles Verified after checking safety numbers).
   */
  public setVerificationState(id: string, state: VerificationState): void {
    const verifiedAt = state === 'VERIFIED' ? Date.now() : null;
    updateContactVerification(id, verifiedAt, state);
  }

  /**
   * Consumes a parsed invitation, creating a contact record and an associated thread.
   */
  public createFromInvite(
    invite: ParsedInvite,
    maskIndex = 0,
    customAlias?: string,
  ): { contact: Contact; thread: Thread } {
    const db = getDb();
    const alias = customAlias ?? invite.nick ?? `Peer ${invite.fingerprint.slice(0, 4)}`;

    // Re-importing a known identity must not fork it into a second contact.
    // Same identity key + same exchange key: reuse. Same identity key + new
    // exchange key: flag CHANGED_IDENTITY on the existing record (audit A-11).
    const known = this.getContactBySignPk(invite.ik);
    const contact = this.saveContact({
      id: known?.id,
      maskIndex,
      alias: known?.alias ?? alias,
      signPk: invite.ik,
      dhPk: invite.xk,
      verified: false,
    });

    const threadId = `th_${contact.id}`;
    const now = Date.now();

    db.execute(
      `INSERT OR IGNORE INTO threads
       (id, contact_id, default_retention, last_activity_at, unread_count)
       VALUES (?,?,?,?,?)`,
      [threadId, contact.id, 'persistent', now, 0],
    );
    if (known && contact.verificationState === 'CHANGED_IDENTITY') {
      // The old session was bound to the previous exchange key.
      db.execute('DELETE FROM ratchets WHERE thread_id = ?', [threadId]);
    }

    return {
      contact,
      thread: {
        id: threadId,
        contactId: contact.id,
        defaultRetention: 'persistent',
        lastActivityAt: now,
        unreadCount: 0,
        contact,
      },
    };
  }

  /** Creates the contact's thread row if it does not exist yet. */
  public ensureThread(contact: Contact): void {
    getDb().execute(
      `INSERT OR IGNORE INTO threads
       (id, contact_id, default_retention, last_activity_at, unread_count)
       VALUES (?,?,?,?,?)`,
      [`th_${contact.id}`, contact.id, 'persistent', Date.now(), 0],
    );
  }

  private recordToContact(r: StoredContactRecord): Contact {
    const stored = r.verificationState as VerificationState | null | undefined;
    const state: VerificationState =
      stored && VERIFICATION_STATES.includes(stored)
        ? stored
        : r.verifiedAt
          ? 'VERIFIED'
          : 'UNVERIFIED';

    return {
      id: r.id,
      maskIndex: r.maskIndex,
      alias: r.alias,
      signPk: r.signPk,
      dhPk: r.dhPk,
      fingerprint: r.fingerprint,
      verifiedAt: r.verifiedAt,
      createdAt: r.createdAt,
      verificationState: state,
    };
  }
}

export const contactManager = new ContactManager();
export default contactManager;
