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
   * Creates or updates a contact. Detects key changes and triggers CHANGED_IDENTITY security event.
   */
  public saveContact(input: CreateContactInput): Contact {
    const now = Date.now();
    const fingerprint = computeFingerprint(input.signPk, input.dhPk);
    const id = input.id ?? `ct_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

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
    updateContactVerification(id, verifiedAt);
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

    const contact = this.saveContact({
      maskIndex,
      alias,
      signPk: invite.ik,
      dhPk: invite.xk,
      verified: false,
    });

    const threadId = `th_${contact.id}`;
    const now = Date.now();

    db.execute(
      `INSERT OR REPLACE INTO threads
       (id, contact_id, default_retention, last_activity_at, unread_count)
       VALUES (?,?,?,?,?)`,
      [threadId, contact.id, 'persistent', now, 0],
    );

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

  private recordToContact(r: StoredContactRecord): Contact {
    const state: VerificationState = r.verifiedAt ? 'VERIFIED' : 'UNVERIFIED';

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
