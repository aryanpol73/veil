/**
 * ============================================================================
 *  VEIL — DUAL-PARTITION ENCRYPTED VAULT
 * ============================================================================
 *  Two database files exist on disk from the moment of provisioning:
 *
 *    veil_vault_primary.db   unlocked by the Master PIN
 *    veil_vault_decoy.db     unlocked by the Ghost PIN
 *
 *  THREAT MODEL (duress / coerced-unlock):
 *  The adversary can see the filesystem and can compel a PIN. Our goal is that
 *  surrendering the Ghost PIN yields a fully functional, unremarkable
 *  messenger, with no observable difference from the primary experience.
 *
 *  Design consequences, each of which is load-bearing:
 *   1. NO PIN VERIFIER IS EVER STORED. The only oracle is the sealed canary
 *      record at meta['canary']. An incorrect PIN fails AEAD decryption.
 *   2. BOTH candidate keys are derived on EVERY unlock attempt, always, in the
 *      same order, so wall-clock unlock time does not reveal which PIN was
 *      entered.
 *   3. Both files are created together, at provisioning, and are page-padded
 *      toward a common size. A decoy created later, or 40x smaller, is a tell.
 *   4. The decoy runs the GHOST persona (mask index 1) as a real identity, so
 *      it sends and receives normally. A decoy that silently drops outbound
 *      messages is trivially detectable by an adversary holding the phone.
 *   5. `isDecoy` is module-private. No screen, log line, analytics event, or
 *      accessibility label may branch on it. The only consumer is the seeder.
 *
 *  HONEST LIMITS: this defeats a casual or procedural inspection. It does not
 *  defeat an adversary who images the device twice and diffs file mtimes, nor
 *  one who has already installed an OS-level keylogger, nor rubber-hose
 *  escalation once the existence of the feature is publicly known. Deniability
 *  is a delay tactic, not a guarantee — the UI copy should say so plainly.
 * ============================================================================
 */

import { Keychain } from './keychain';
import {
  CRYPTO,
  deriveVaultKey,
  randomBytes,
  toB64,
  fromB64,
  toHex,
  deriveSubSeed,
  wipe,
  aeadEncrypt,
  aeadDecrypt,
  packSealed,
  unpackSealed,
  timingSafeEqual,
} from '../crypto/keys';
import { defaultDriver } from './sqliteDriver';
import type { RetentionMode } from '../theme/obsidianPrism';

/* -------------------------------------------------------------------------- */
/* Codecs                                                                     */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8 = (s: string): Uint8Array => encoder.encode(s);
const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);

/* -------------------------------------------------------------------------- */
/* Driver abstraction                                                         */
/* -------------------------------------------------------------------------- */

export interface SqlResult<T = any> {
  rows: T[];
  rowsAffected: number;
  insertId?: number;
}

export interface SqlConnection {
  execute<T = any>(sql: string, params?: any[]): SqlResult<T>;
  transaction(fn: () => void): void;
  close(): void;
  delete(): void;
}

export interface SqlDriver {
  /** Opens (or creates) a database file. */
  open(name: string): SqlConnection;
}

let driver: SqlDriver = defaultDriver;

/** Test/platform seam. */
export const setSqlDriver = (d: SqlDriver): void => {
  driver = d;
};

/* -------------------------------------------------------------------------- */
/* Partitions                                                                 */
/* -------------------------------------------------------------------------- */

export type Partition = 'primary' | 'decoy';

const FILES: Record<Partition, string> = {
  primary: 'veil_vault_primary.db',
  decoy: 'veil_vault_decoy.db',
};

/** Argon2id domain labels — distinct per partition by construction. */
const PARTITION_LABEL: Record<Partition, string> = {
  primary: 'partition.primary',
  decoy: 'partition.decoy',
};

/**
 * The device salt is the ONLY thing we keep in the OS keystore, and it is not
 * secret-bearing on its own: without a PIN it derives nothing. It lives in the
 * Keychain/Keystore so that a filesystem-only image (no secure element) cannot
 * even begin an offline PIN grind.
 */
const SALT_KEY = 'veil.vault.device_salt.v1';

async function loadOrCreateDeviceSalt(): Promise<Uint8Array> {
  const existing = await Keychain.getItem(SALT_KEY);
  if (existing) return fromB64(existing);
  const salt = randomBytes(CRYPTO.VAULT_SALT_BYTES);
  await Keychain.setItem(SALT_KEY, toB64(salt));
  return salt;
}

/* -------------------------------------------------------------------------- */
/* Schema & Pragmas                                                           */
/* -------------------------------------------------------------------------- */

/**
 * SQLite hardening pragmas.
 * Note: PRAGMA key and cipher_* pragmas are completely removed to prevent
 * silent no-op leaks on standard SQLite.
 */
const PRAGMAS = [
  'PRAGMA secure_delete = ON',
  'PRAGMA journal_mode = WAL',
  'PRAGMA auto_vacuum = INCREMENTAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA temp_store = MEMORY', // never spill plaintext temp b-trees to disk
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- Masks metadata. Label and fingerprint are sealed with AEAD using the partition key.
CREATE TABLE IF NOT EXISTS masks (
  mask_index   INTEGER PRIMARY KEY NOT NULL,
  label        TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Contacts table. All sensitive fields (alias, sign_pk, dh_pk, fingerprint) are sealed with AEAD
-- using the active vault key at the application layer. fp_tag provides a deterministic keyed blind index.
CREATE TABLE IF NOT EXISTS contacts (
  id           TEXT PRIMARY KEY NOT NULL,
  mask_index   INTEGER NOT NULL,
  alias        TEXT NOT NULL,
  sign_pk      TEXT NOT NULL,
  dh_pk        TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  fp_tag       TEXT,
  verified_at  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_fp_tag ON contacts(fp_tag);

CREATE TABLE IF NOT EXISTS threads (
  id                 TEXT PRIMARY KEY NOT NULL,
  contact_id         TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  default_retention  TEXT NOT NULL DEFAULT 'persistent',
  last_activity_at   INTEGER NOT NULL,
  unread_count       INTEGER NOT NULL DEFAULT 0
);

-- Ratchet state. Sensitive ratchet secrets and DH keys are sealed with AEAD at application layer using the active vault key.
CREATE TABLE IF NOT EXISTS ratchets (
  thread_id        TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  root_key         TEXT NOT NULL,
  send_chain_key   TEXT,
  recv_chain_key   TEXT,
  send_dh_sk       TEXT NOT NULL,
  send_dh_pk       TEXT NOT NULL,
  recv_dh_pk       TEXT,
  send_counter     INTEGER NOT NULL DEFAULT 0,
  recv_counter     INTEGER NOT NULL DEFAULT 0,
  prev_chain_len   INTEGER NOT NULL DEFAULT 0,
  skipped_keys     TEXT
);

-- Persistent and Timed messages only. View-Once NEVER reaches this table;
-- see RamVault below. The CHECK constraint enforces that at the storage layer
-- so a future code path cannot accidentally persist one.
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY NOT NULL,
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  retention    TEXT NOT NULL CHECK (retention IN ('persistent','timed')),
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  ttl_ms       INTEGER,
  delivered_at INTEGER,
  read_at      INTEGER,
  counter      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_expiry  ON messages(expires_at) WHERE expires_at IS NOT NULL;

-- Fixed-size padding table. Provisioning inflates the smaller vault so the two
-- files land within one page-group of each other on disk (see padToward()).
CREATE TABLE IF NOT EXISTS ballast (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  blob BLOB NOT NULL
);
`;

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

export interface VaultSession {
  db: SqlConnection;
  /** Opaque, stable per unlock. Safe to log. Reveals nothing about partition. */
  sessionId: string;
}

interface InternalSession extends VaultSession {
  partition: Partition;
  vaultKey: Uint8Array;
}

let active: InternalSession | null = null;

/** PRIVATE. Only the decoy seeder may consult this. Never expose to the UI. */
const __isDecoy = (): boolean => active?.partition === 'decoy';

/**
 * Which mask index the active partition drives. The decoy transparently runs
 * the Ghost persona, so every downstream call site (relay subscription, invite
 * generation, ratchet setup) works identically without knowing why.
 */
export const activeMaskIndex = (): number => (__isDecoy() ? 1 : 0);

export const getDb = (): SqlConnection => {
  if (!active) throw new Error('[veil/db] vault is locked.');
  return active.db;
};

export const getSession = (): VaultSession | null =>
  active ? { db: active.db, sessionId: active.sessionId } : null;

/* -------------------------------------------------------------------------- */
/* Open / Canary / Migrate                                                    */
/* -------------------------------------------------------------------------- */

const CANARY_PLAINTEXT = utf8('veil.canary.v1');

function applyPragmas(conn: SqlConnection): void {
  for (const p of PRAGMAS) conn.execute(p);
}

/**
 * Attempts to open a partition. Returns null on the wrong key or if unprovisioned.
 *
 * Validates access using the sealed canary at meta['canary'] with domain-separated AAD.
 */
function tryOpen(partition: Partition, rawKey: Uint8Array): SqlConnection | null {
  let conn: SqlConnection | null = null;
  try {
    conn = driver.open(FILES[partition]);
    applyPragmas(conn);

    const res = conn.execute<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      ['canary'],
    );
    const canaryRow = res.rows?.[0];
    if (!canaryRow || !canaryRow.value) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      return null;
    }

    const sealed = unpackSealed(canaryRow.value);
    if (!sealed) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      return null;
    }

    const aad = utf8(PARTITION_LABEL[partition]);
    const pt = aeadDecrypt(rawKey, sealed, aad);
    if (!pt) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      return null;
    }

    const match = timingSafeEqual(pt, CANARY_PLAINTEXT);
    wipe(pt);

    if (!match) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      return null;
    }

    return conn;
  } catch {
    try {
      conn?.close();
    } catch {
      /* nothing recoverable, and nothing to report */
    }
    return null;
  }
}

/**
 * Splits a multi-statement SQL script into individual executable statements.
 *
 * WHY NAIVE SPLIT IS UNSAFE:
 * Naively calling `SCHEMA.split(';')` breaks when any comment or literal
 * contains a semicolon (e.g. `-- Ratchet state. Encrypted at rest; keys...`).
 * The fragment immediately following the semicolon will no longer be treated
 * as a comment by the SQLite engine, causing a syntax error that aborts and
 * rolls back the entire `migrate()` transaction on native platforms.
 *
 * Stripping `--` line comments prior to splitting on semicolons guarantees
 * that semicolons inside comments cannot divide SQL statements.
 */
export function splitSqlStatements(sql: string): string[] {
  return sql
    .replace(/--[^\r\n]*/g, '')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

function migrate(conn: SqlConnection): void {
  conn.transaction(() => {
    for (const sql of splitSqlStatements(SCHEMA)) {
      conn.execute(sql);
    }
    try {
      conn.execute('ALTER TABLE contacts ADD COLUMN fp_tag TEXT');
    } catch {
      /* ignore if column exists */
    }
    try {
      conn.execute('ALTER TABLE ratchets ADD COLUMN skipped_keys TEXT');
    } catch {
      /* ignore if column exists */
    }
    conn.execute('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)', ['schema_version', '1']);
  });
}

/* -------------------------------------------------------------------------- */
/* Message Body & Ratchet Sealing Helpers                                     */
/* -------------------------------------------------------------------------- */

function openMessageBody(vaultKey: Uint8Array, id: string, storedBody: string): string {
  try {
    const sealed = unpackSealed(storedBody);
    if (!sealed) return '[unreadable]';
    const aad = utf8(`msg|${id}`);
    const pt = aeadDecrypt(vaultKey, sealed, aad);
    if (!pt) return '[unreadable]';
    const text = fromUtf8(pt);
    wipe(pt);
    return text;
  } catch {
    return '[unreadable]';
  }
}

export interface StoredSkippedKey {
  id: string;
  remoteDhPkHex?: string;
  counter: number;
  messageKey: Uint8Array;
  createdAt: number;
}

export interface RatchetState {
  rootKey: Uint8Array;
  sendChainKey: Uint8Array | null;
  recvChainKey: Uint8Array | null;
  sendDhSk: Uint8Array;
  sendDhPk: Uint8Array;
  recvDhPk: Uint8Array | null;
  sendCounter: number;
  recvCounter: number;
  prevChainLen: number;
  skippedKeys?: StoredSkippedKey[];
  root_key?: Uint8Array;
  send_chain_key?: Uint8Array | null;
  recv_chain_key?: Uint8Array | null;
  send_dh_sk?: Uint8Array;
  send_dh_pk?: Uint8Array;
  recv_dh_pk?: Uint8Array | null;
  send_counter?: number;
  recv_counter?: number;
  prev_chain_len?: number;
  skipped_keys?: StoredSkippedKey[];
}

function sealBlob(
  field: string,
  threadId: string,
  bytes: Uint8Array | null | undefined,
): string | null {
  if (!bytes) return null;
  if (!active) throw new Error('[veil/db] vault is locked.');
  const aad = utf8(`ratchet|${threadId}|${field}`);
  const sealed = aeadEncrypt(active.vaultKey, bytes, aad);
  return packSealed(sealed);
}

function openBlob(
  field: string,
  threadId: string,
  stored: string | null | undefined,
): Uint8Array | null {
  if (!stored) return null;
  if (!active) throw new Error('[veil/db] vault is locked.');
  const sealed = unpackSealed(stored);
  if (!sealed) return null;
  const aad = utf8(`ratchet|${threadId}|${field}`);
  return aeadDecrypt(active.vaultKey, sealed, aad);
}

export function saveRatchet(threadId: string, state: RatchetState): void {
  const db = getDb();
  const rootKey = state.rootKey ?? state.root_key;
  if (!rootKey) throw new Error('[veil/db] rootKey is required to save ratchet.');
  const sendChainKey =
    state.sendChainKey !== undefined ? state.sendChainKey : (state.send_chain_key ?? null);
  const recvChainKey =
    state.recvChainKey !== undefined ? state.recvChainKey : (state.recv_chain_key ?? null);
  const sendDhSk = state.sendDhSk ?? state.send_dh_sk;
  if (!sendDhSk) throw new Error('[veil/db] sendDhSk is required to save ratchet.');
  const sendDhPk = state.sendDhPk ?? state.send_dh_pk;
  if (!sendDhPk) throw new Error('[veil/db] sendDhPk is required to save ratchet.');
  const recvDhPk =
    state.recvDhPk !== undefined ? state.recvDhPk : (state.recv_dh_pk ?? null);
  const sendCounter = state.sendCounter ?? state.send_counter ?? 0;
  const recvCounter = state.recvCounter ?? state.recv_counter ?? 0;
  const prevChainLen = state.prevChainLen ?? state.prev_chain_len ?? 0;

  const sealedRoot = sealBlob('root_key', threadId, rootKey);
  const sealedSendChain = sealBlob('send_chain_key', threadId, sendChainKey);
  const sealedRecvChain = sealBlob('recv_chain_key', threadId, recvChainKey);
  const sealedSendDhSk = sealBlob('send_dh_sk', threadId, sendDhSk);
  const sealedSendDhPk = sealBlob('send_dh_pk', threadId, sendDhPk);
  const sealedRecvDhPk = sealBlob('recv_dh_pk', threadId, recvDhPk);

  let sealedSkippedKeys: string | null = null;
  const skippedList = state.skippedKeys ?? state.skipped_keys;
  if (skippedList && skippedList.length > 0) {
    const raw = JSON.stringify(
      skippedList.map((k) => ({
        id: k.id,
        remoteDhPkHex: k.remoteDhPkHex,
        counter: k.counter,
        messageKey: toB64(k.messageKey),
        createdAt: k.createdAt,
      })),
    );
    sealedSkippedKeys = sealBlob('skipped_keys', threadId, utf8(raw));
  }

  db.execute(
    `INSERT OR REPLACE INTO ratchets
     (thread_id, root_key, send_chain_key, recv_chain_key, send_dh_sk, send_dh_pk, recv_dh_pk, send_counter, recv_counter, prev_chain_len, skipped_keys)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      threadId,
      sealedRoot,
      sealedSendChain,
      sealedRecvChain,
      sealedSendDhSk,
      sealedSendDhPk,
      sealedRecvDhPk,
      sendCounter,
      recvCounter,
      prevChainLen,
      sealedSkippedKeys,
    ],
  );
}

export function loadRatchet(threadId: string): RatchetState | null {
  const db = getDb();
  const rows = db.execute<any>('SELECT * FROM ratchets WHERE thread_id = ?', [threadId]).rows;
  if (!rows || rows.length === 0) return null;
  const row = rows[0];

  const rootKey = openBlob('root_key', threadId, row.root_key);
  if (!rootKey) return null;
  const sendChainKey = openBlob('send_chain_key', threadId, row.send_chain_key);
  const recvChainKey = openBlob('recv_chain_key', threadId, row.recv_chain_key);
  const sendDhSk = openBlob('send_dh_sk', threadId, row.send_dh_sk);
  if (!sendDhSk) return null;

  let sendDhPk = openBlob('send_dh_pk', threadId, row.send_dh_pk);
  if (!sendDhPk && row.send_dh_pk) {
    sendDhPk = row.send_dh_pk instanceof Uint8Array ? row.send_dh_pk : new Uint8Array(row.send_dh_pk);
  }
  if (!sendDhPk) return null;

  let recvDhPk = openBlob('recv_dh_pk', threadId, row.recv_dh_pk);
  if (!recvDhPk && row.recv_dh_pk) {
    recvDhPk = row.recv_dh_pk instanceof Uint8Array ? row.recv_dh_pk : new Uint8Array(row.recv_dh_pk);
  }

  let skippedKeys: StoredSkippedKey[] = [];
  if (row.skipped_keys) {
    const pt = openBlob('skipped_keys', threadId, row.skipped_keys);
    if (pt) {
      try {
        const parsed = JSON.parse(fromUtf8(pt));
        if (Array.isArray(parsed)) {
          skippedKeys = parsed.map((item: any) => ({
            id: item.id,
            remoteDhPkHex: item.remoteDhPkHex,
            counter: item.counter,
            messageKey: fromB64(item.messageKey),
            createdAt: item.createdAt,
          }));
        }
      } catch {
        /* ignore corrupted skipped keys */
      }
    }
  }

  return {
    rootKey,
    root_key: rootKey,
    sendChainKey,
    send_chain_key: sendChainKey,
    recvChainKey,
    recv_chain_key: recvChainKey,
    sendDhSk,
    send_dh_sk: sendDhSk,
    sendDhPk,
    send_dh_pk: sendDhPk,
    recvDhPk,
    recv_dh_pk: recvDhPk,
    sendCounter: row.send_counter ?? 0,
    send_counter: row.send_counter ?? 0,
    recvCounter: row.recv_counter ?? 0,
    recv_counter: row.recv_counter ?? 0,
    prevChainLen: row.prev_chain_len ?? 0,
    prev_chain_len: row.prev_chain_len ?? 0,
    skippedKeys,
    skipped_keys: skippedKeys,
  };
}

/* -------------------------------------------------------------------------- */
/* Provisioning                                                               */
/* -------------------------------------------------------------------------- */

export interface ProvisionInput {
  masterPin: string;
  ghostPin: string;
  primaryFingerprint: string;
  ghostFingerprint: string;
  primarySeed?: Uint8Array;
  ghostSeed?: Uint8Array;
}

/**
 * First-run setup. Creates BOTH vaults in one pass. This must never be split
 * into "create primary now, decoy later" — divergent file creation times are
 * the easiest possible forensic tell.
 */
export async function provisionVaults(input: ProvisionInput): Promise<void> {
  if (input.masterPin === input.ghostPin) {
    throw new Error('[veil/db] master and ghost PINs must differ.');
  }
  if (input.masterPin.length < 6 || input.ghostPin.length < 6) {
    throw new Error('[veil/db] PINs must be at least 6 characters.');
  }

  const salt = await loadOrCreateDeviceSalt();
  const primaryKey = deriveVaultKey(input.masterPin, salt, PARTITION_LABEL.primary);
  const decoyKey = deriveVaultKey(input.ghostPin, salt, PARTITION_LABEL.decoy);

  const pSeed = input.primarySeed ?? randomBytes(CRYPTO.SEED_BYTES);
  const gSeed = input.ghostSeed ?? randomBytes(CRYPTO.SEED_BYTES);

  try {
    const primary = driver.open(FILES.primary);
    applyPragmas(primary);
    migrate(primary);

    // Sealed canary for primary
    const primaryCanary = packSealed(
      aeadEncrypt(primaryKey, CANARY_PLAINTEXT, utf8(PARTITION_LABEL.primary)),
    );
    primary.execute('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [
      'canary',
      primaryCanary,
    ]);
    const sealedPrimaryFp = packSealed(
      aeadEncrypt(primaryKey, utf8(input.primaryFingerprint), utf8('mask|0|fp')),
    );
    const sealedPrimaryLabel = packSealed(
      aeadEncrypt(primaryKey, utf8('Personal'), utf8('mask|0|label')),
    );
    primary.execute(
      'INSERT OR REPLACE INTO masks(mask_index, label, fingerprint, created_at) VALUES (?,?,?,?)',
      [0, sealedPrimaryLabel, sealedPrimaryFp, Date.now()],
    );
    primary.execute('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [
      'master_seed',
      packSealed(aeadEncrypt(primaryKey, pSeed, utf8('master_seed'))),
    ]);

    const decoy = driver.open(FILES.decoy);
    applyPragmas(decoy);
    migrate(decoy);

    // Sealed canary for decoy
    const decoyCanary = packSealed(
      aeadEncrypt(decoyKey, CANARY_PLAINTEXT, utf8(PARTITION_LABEL.decoy)),
    );
    decoy.execute('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [
      'canary',
      decoyCanary,
    ]);
    const sealedGhostFp = packSealed(
      aeadEncrypt(decoyKey, utf8(input.ghostFingerprint), utf8('mask|1|fp')),
    );
    const sealedGhostLabel = packSealed(
      aeadEncrypt(decoyKey, utf8('Personal'), utf8('mask|1|label')),
    );
    decoy.execute(
      'INSERT OR REPLACE INTO masks(mask_index, label, fingerprint, created_at) VALUES (?,?,?,?)',
      [1, sealedGhostLabel, sealedGhostFp, Date.now()],
    );
    decoy.execute('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [
      'master_seed',
      packSealed(aeadEncrypt(decoyKey, gSeed, utf8('master_seed'))),
    ]);

    seedDecoy(decoy, decoyKey);

    // Equalize on-disk footprint, then close both together.
    padToward(primary, decoy);
    primary.close();
    decoy.close();
  } finally {
    wipe(primaryKey, decoyKey);
  }
}

export function saveSealedMasterSeed(masterSeed: Uint8Array): void {
  if (!active) throw new Error('[veil/db] vault is locked.');
  const sealed = packSealed(
    aeadEncrypt(active.vaultKey, masterSeed, utf8('master_seed')),
  );
  getDb().execute('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)', [
    'master_seed',
    sealed,
  ]);
}

export function loadSealedMasterSeed(): Uint8Array | null {
  if (!active) return null;
  const rows = getDb().execute<{ value: string }>(
    'SELECT value FROM meta WHERE key = ?',
    ['master_seed'],
  ).rows;
  if (!rows || rows.length === 0 || !rows[0].value) return null;
  const sealed = unpackSealed(rows[0].value);
  if (!sealed) return null;
  return aeadDecrypt(active.vaultKey, sealed, utf8('master_seed'));
}

export function isProvisioned(): boolean {
  try {
    const conn = driver.open(FILES.primary);
    applyPragmas(conn);
    const rows = conn.execute<{ value: string }>(
      'SELECT value FROM meta WHERE key = ?',
      ['canary'],
    ).rows;
    conn.close();
    return !!(rows && rows.length > 0 && rows[0].value);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Contact Records (Encrypted at rest with AEAD + Blind Index Tag)            */
/* -------------------------------------------------------------------------- */

export interface StoredContactRecord {
  id: string;
  maskIndex: number;
  alias: string;
  signPk: Uint8Array;
  dhPk: Uint8Array;
  fingerprint: string;
  verifiedAt: number | null;
  createdAt: number;
}

export function computeContactFpTag(fingerprint: string, vaultKey?: Uint8Array): string {
  const key = vaultKey ?? active?.vaultKey;
  if (!key) throw new Error('[veil/db] vault is locked.');
  return toHex(deriveSubSeed(key, `veil.contact.tag|${fingerprint}`, 16));
}

export function saveContactRow(
  contact: StoredContactRecord,
  customVaultKey?: Uint8Array,
  customConn?: SqlConnection,
): void {
  const conn = customConn ?? getDb();
  const key = customVaultKey ?? active?.vaultKey;
  if (!key) throw new Error('[veil/db] vault is locked.');

  const sealedAlias = packSealed(aeadEncrypt(key, utf8(contact.alias), utf8(`contact|${contact.id}|alias`)));
  const sealedSignPk = packSealed(aeadEncrypt(key, contact.signPk, utf8(`contact|${contact.id}|sign_pk`)));
  const sealedDhPk = packSealed(aeadEncrypt(key, contact.dhPk, utf8(`contact|${contact.id}|dh_pk`)));
  const sealedFp = packSealed(aeadEncrypt(key, utf8(contact.fingerprint), utf8(`contact|${contact.id}|fingerprint`)));
  const fpTag = computeContactFpTag(contact.fingerprint, key);

  conn.execute(
    `INSERT OR REPLACE INTO contacts
     (id, mask_index, alias, sign_pk, dh_pk, fingerprint, fp_tag, verified_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      contact.id,
      contact.maskIndex,
      sealedAlias,
      sealedSignPk,
      sealedDhPk,
      sealedFp,
      fpTag,
      contact.verifiedAt,
      contact.createdAt,
    ],
  );
}

function parseContactRow(row: any, vaultKey: Uint8Array): StoredContactRecord | null {
  try {
    const id = row.id;

    // Decrypt alias
    let alias = row.alias;
    const sealedAlias = typeof row.alias === 'string' ? unpackSealed(row.alias) : null;
    if (sealedAlias) {
      const pt = aeadDecrypt(vaultKey, sealedAlias, utf8(`contact|${id}|alias`));
      if (pt) alias = fromUtf8(pt);
    }

    // Decrypt signPk
    let signPk: Uint8Array;
    const sealedSign = typeof row.sign_pk === 'string' ? unpackSealed(row.sign_pk) : null;
    if (sealedSign) {
      const pt = aeadDecrypt(vaultKey, sealedSign, utf8(`contact|${id}|sign_pk`));
      signPk = pt ?? new Uint8Array(32);
    } else if (row.sign_pk instanceof Uint8Array) {
      signPk = row.sign_pk;
    } else {
      signPk = new Uint8Array(row.sign_pk ?? 32);
    }

    // Decrypt dhPk
    let dhPk: Uint8Array;
    const sealedDh = typeof row.dh_pk === 'string' ? unpackSealed(row.dh_pk) : null;
    if (sealedDh) {
      const pt = aeadDecrypt(vaultKey, sealedDh, utf8(`contact|${id}|dh_pk`));
      dhPk = pt ?? new Uint8Array(32);
    } else if (row.dh_pk instanceof Uint8Array) {
      dhPk = row.dh_pk;
    } else {
      dhPk = new Uint8Array(row.dh_pk ?? 32);
    }

    // Decrypt fingerprint
    let fingerprint = row.fingerprint;
    const sealedFp = typeof row.fingerprint === 'string' ? unpackSealed(row.fingerprint) : null;
    if (sealedFp) {
      const pt = aeadDecrypt(vaultKey, sealedFp, utf8(`contact|${id}|fingerprint`));
      if (pt) fingerprint = fromUtf8(pt);
    }

    return {
      id,
      maskIndex: row.mask_index,
      alias,
      signPk,
      dhPk,
      fingerprint,
      verifiedAt: row.verified_at ?? null,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

export function loadContactRow(id: string): StoredContactRecord | null {
  if (!active) return null;
  const rows = getDb().execute<any>('SELECT * FROM contacts WHERE id = ?', [id]).rows;
  if (!rows || rows.length === 0) return null;
  return parseContactRow(rows[0], active.vaultKey);
}

export function loadContactRowByFingerprint(fingerprint: string): StoredContactRecord | null {
  if (!active) return null;
  const tag = computeContactFpTag(fingerprint, active.vaultKey);
  const rows = getDb().execute<any>('SELECT * FROM contacts WHERE fp_tag = ?', [tag]).rows;
  if (rows && rows.length > 0) {
    const contact = parseContactRow(rows[0], active.vaultKey);
    if (contact && contact.fingerprint === fingerprint) return contact;
  }
  // Fallback: list all and match
  const all = listContactRows();
  return all.find((c) => c.fingerprint === fingerprint) ?? null;
}

export function listContactRows(): StoredContactRecord[] {
  if (!active) return [];
  const rows = getDb().execute<any>('SELECT * FROM contacts ORDER BY created_at DESC').rows;
  if (!rows) return [];
  const contacts: StoredContactRecord[] = [];
  for (const r of rows) {
    const c = parseContactRow(r, active.vaultKey);
    if (c) contacts.push(c);
  }
  return contacts;
}

export function updateContactVerification(id: string, verifiedAt: number | null): void {
  if (!active) return;
  getDb().execute('UPDATE contacts SET verified_at = ? WHERE id = ?', [verifiedAt, id]);
}

/**
 * Seeds the decoy with neutral, boring, plausibly-aged content: a handful of
 * contacts and logistics chatter spread over the past few weeks. An empty
 * decoy is worse than no decoy — it reads as freshly manufactured.
 */
function seedDecoy(conn: SqlConnection, vaultKey: Uint8Array): void {
  const now = Date.now();
  const DAY = 86_400_000;

  const people: Array<[string, string]> = [
    ['Dana R.', 'K7QP 4M2X 9WVE 3TNA 6HJD'],
    ['Marco', 'B2XR 8T5K 1QMW 7NPV 4ZCE'],
    ['Cycling Group', 'V9WM 3KQT 6XPB 2NER 8HAD'],
    ['Aunt Lily', 'T4NC 7VPQ 2MKX 9WRB 5ZEH'],
  ];

  const chatter: Array<[number, 'in' | 'out', string, number]> = [
    [0, 'in', 'are we still on for saturday?', 19 * DAY],
    [0, 'out', 'yep — 10am at the usual place', 19 * DAY - 4e5],
    [0, 'in', 'perfect, ill bring the thermos', 19 * DAY - 9e5],
    [1, 'out', 'did you ever get that invoice sorted?', 12 * DAY],
    [1, 'in', 'finally, yes. took three emails', 12 * DAY - 3e6],
    [2, 'in', 'route change this week, meeting at the north gate', 6 * DAY],
    [2, 'out', 'noted. weather looks fine', 6 * DAY - 6e5],
    [3, 'in', 'the photos came out lovely, thank you', 2 * DAY],
    [3, 'out', 'ill print a few and post them over', 2 * DAY - 1.2e6],
    [0, 'in', 'running about 10 min late, sorry!', 4 * 3.6e6],
  ];

  conn.transaction(() => {
    people.forEach(([alias, fp], i) => {
      const contactId = `dc_${i}`;
      const threadId = `dt_${i}`;
      saveContactRow(
        {
          id: contactId,
          maskIndex: 1,
          alias,
          signPk: randomBytes(32),
          dhPk: randomBytes(32),
          fingerprint: fp,
          verifiedAt: i < 2 ? now - 20 * DAY : null,
          createdAt: now - (30 - i * 4) * DAY,
        },
        vaultKey,
        conn,
      );
      conn.execute(
        `INSERT OR REPLACE INTO threads
         (id, contact_id, default_retention, last_activity_at, unread_count)
         VALUES (?,?,?,?,?)`,
        [threadId, contactId, 'persistent', now - DAY, 0],
      );
    });

    chatter.forEach(([threadIdx, direction, body, ago], i) => {
      const msgId = `dm_${i}`;
      const sealedBody = packSealed(
        aeadEncrypt(vaultKey, utf8(body), utf8(`msg|${msgId}`)),
      );
      conn.execute(
        `INSERT OR REPLACE INTO messages
         (id, thread_id, direction, retention, body, created_at, delivered_at, read_at, counter)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          msgId,
          `dt_${threadIdx}`,
          direction,
          'persistent',
          sealedBody,
          now - ago,
          now - ago + 1500,
          now - ago + 60_000,
          i,
        ],
      );
    });

    conn.execute('UPDATE threads SET unread_count = 1 WHERE id = ?', ['dt_0']);
  });
}

/**
 * Inflates the smaller of the two vaults with incompressible random ballast so
 * their page counts converge. Ballast is indistinguishable from real content.
 */
function padToward(a: SqlConnection, b: SqlConnection): void {
  const pages = (c: SqlConnection): number =>
    Number(Object.values(c.execute('PRAGMA page_count')?.rows?.[0] ?? {})[0] ?? 0);

  const target = Math.max(pages(a), pages(b)) + 64; // headroom for organic growth
  for (const conn of [a, b]) {
    let guard = 0;
    while (pages(conn) < target && guard++ < 4096) {
      conn.transaction(() => {
        for (let i = 0; i < 16; i++) {
          conn.execute('INSERT INTO ballast(blob) VALUES (?)', [randomBytes(4096)]);
        }
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Unlock                                                                     */
/* -------------------------------------------------------------------------- */

export type UnlockResult = { ok: true; session: VaultSession } | { ok: false };

/**
 * The single entry point for PIN entry.
 *
 * Both KDF derivations run unconditionally and in fixed order, so a coercer
 * with a stopwatch learns nothing. On success the caller receives an opaque
 * session; there is no field, flag, or thrown warning anywhere in the return
 * type that distinguishes a decoy unlock. That absence is the feature.
 */
export async function unlockWithPin(pin: string): Promise<UnlockResult> {
  await lockVault();

  const salt = await loadOrCreateDeviceSalt();

  // Fixed, unconditional work: derive both candidates every single time.
  const primaryKey = deriveVaultKey(pin, salt, PARTITION_LABEL.primary);
  const decoyKey = deriveVaultKey(pin, salt, PARTITION_LABEL.decoy);

  let opened: { conn: SqlConnection; partition: Partition } | null = null;
  let activeKey: Uint8Array | null = null;
  try {
    const p = tryOpen('primary', primaryKey);
    const d = p ? null : tryOpen('decoy', decoyKey);

    if (p) {
      opened = { conn: p, partition: 'primary' };
      activeKey = new Uint8Array(primaryKey);
    } else if (d) {
      opened = { conn: d, partition: 'decoy' };
      activeKey = new Uint8Array(decoyKey);
    }
    if (!opened || !activeKey) return { ok: false };

    migrate(opened.conn);

    active = {
      db: opened.conn,
      partition: opened.partition,
      vaultKey: activeKey,
      sessionId: toB64(randomBytes(16)),
    };

    // Identical post-unlock behaviour in both partitions.
    sweepExpired();
    startSweepTimer();

    return { ok: true, session: { db: active.db, sessionId: active.sessionId } };
  } finally {
    wipe(primaryKey, decoyKey);
  }
}

export async function lockVault(): Promise<void> {
  stopSweepTimer();
  RamVault.purgeAll();
  if (active) {
    try {
      active.db.execute('PRAGMA incremental_vacuum');
      // Truncate the WAL file so deleted pages don't survive in slack space
      active.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      active.db.close();
    } catch {
      /* closing a dying handle is not actionable */
    }
    wipe(active.vaultKey);
    active = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Message records                                                            */
/* -------------------------------------------------------------------------- */

export interface StoredMessage {
  id: string;
  thread_id: string;
  direction: 'in' | 'out';
  retention: RetentionMode;
  body: string;
  created_at: number;
  expires_at: number | null;
  ttl_ms: number | null;
  delivered_at: number | null;
  read_at: number | null;
  counter: number;
}

export interface InsertMessageInput {
  id: string;
  threadId: string;
  direction: 'in' | 'out';
  retention: RetentionMode;
  body: string;
  ttlMs?: number;
  counter?: number;
}

/**
 * Writes a message. View-Once is routed to RAM and never touches SQLite — the
 * `messages.retention` CHECK constraint would reject it anyway, which is a
 * deliberate belt-and-braces against a future refactor.
 */
export function insertMessage(input: InsertMessageInput): StoredMessage {
  const now = Date.now();

  if (input.retention === 'viewOnce') {
    return RamVault.put({
      id: input.id,
      thread_id: input.threadId,
      direction: input.direction,
      retention: 'viewOnce',
      body: input.body,
      created_at: now,
      expires_at: null,
      ttl_ms: null,
      delivered_at: null,
      read_at: null,
      counter: input.counter ?? 0,
    });
  }

  const expiresAt =
    input.retention === 'timed' && input.ttlMs ? now + input.ttlMs : null;

  if (!active) {
    return RamVault.put({
      id: input.id,
      thread_id: input.threadId,
      direction: input.direction,
      retention: input.retention,
      body: input.body,
      created_at: now,
      expires_at: expiresAt,
      ttl_ms: input.ttlMs ?? null,
      delivered_at: null,
      read_at: null,
      counter: input.counter ?? 0,
    });
  }

  const db = getDb();
  const aad = utf8(`msg|${input.id}`);
  const sealedBody = packSealed(aeadEncrypt(active.vaultKey, utf8(input.body), aad));

  db.transaction(() => {
    db.execute(
      `INSERT INTO messages
       (id, thread_id, direction, retention, body, created_at, expires_at, ttl_ms, counter)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        input.id,
        input.threadId,
        input.direction,
        input.retention,
        sealedBody,
        now,
        expiresAt,
        input.ttlMs ?? null,
        input.counter ?? 0,
      ],
    );
    db.execute('UPDATE threads SET last_activity_at = ? WHERE id = ?', [now, input.threadId]);
  });

  return {
    id: input.id,
    thread_id: input.threadId,
    direction: input.direction,
    retention: input.retention,
    body: input.body,
    created_at: now,
    expires_at: expiresAt,
    ttl_ms: input.ttlMs ?? null,
    delivered_at: null,
    read_at: null,
    counter: input.counter ?? 0,
  };
}

/** Merges the persisted tail with any live RAM-only messages, newest last. */
export function listMessages(threadId: string, limit = 200): StoredMessage[] {
  if (!active) {
    return RamVault.byThread(threadId);
  }
  const persisted = getDb().execute<StoredMessage>(
    `SELECT * FROM messages
     WHERE thread_id = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC LIMIT ?`,
    [threadId, Date.now(), limit],
  ).rows;

  const decrypted = persisted.map((m) => ({
    ...m,
    body: openMessageBody(active!.vaultKey, m.id, m.body),
  }));

  return [...decrypted.reverse(), ...RamVault.byThread(threadId)].sort(
    (a, b) => a.created_at - b.created_at,
  );
}

export function markDelivered(id: string): void {
  if (!active) return;
  getDb().execute('UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL', [
    Date.now(),
    id,
  ]);
}

/**
 * Starts a Timed message's countdown at first read rather than at send.
 */
export function markReadAndArmTtl(id: string): void {
  if (!active) {
    const m = RamVault.get(id);
    if (m && !m.read_at) {
      m.read_at = Date.now();
      if (m.retention === 'timed' && m.ttl_ms) {
        m.expires_at = m.read_at + m.ttl_ms;
      }
    }
    return;
  }
  const db = getDb();
  const row = db.execute<StoredMessage>('SELECT * FROM messages WHERE id = ?', [id]).rows[0];
  if (!row || row.read_at) return;
  const now = Date.now();
  db.execute('UPDATE messages SET read_at = ?, expires_at = ? WHERE id = ?', [
    now,
    row.retention === 'timed' && row.ttl_ms ? now + row.ttl_ms : row.expires_at,
    id,
  ]);
}

/**
 * Deletes everything past its TTL and returns freed pages to the OS.
 */
export function sweepExpired(): number {
  if (!active) return 0;
  const db = active.db;
  let removed = 0;
  db.transaction(() => {
    removed = db.execute('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?', [
      Date.now(),
    ]).rowsAffected;
  });
  if (removed > 0) {
    db.execute('PRAGMA incremental_vacuum');
    /**
     * WAL VS TTL TRADEOFF:
     * We retain `journal_mode = WAL` because WAL is necessary for concurrent reads during
     * background TTL sweeps. However, SQLite WAL mode retains deleted pages inside the `-wal`
     * file until a checkpoint occurs, allowing swept timed messages to persist on disk.
     * To solve this without sacrificing read concurrency, we run `PRAGMA wal_checkpoint(TRUNCATE)`
     * immediately after every sweep deletion and inside `lockVault()`. This flushes and truncates
     * the `-wal` file to zero bytes, guaranteeing that deleted messages do not linger in the WAL.
     */
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  removed += RamVault.sweep();
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
const startSweepTimer = () => {
  stopSweepTimer();
  sweepTimer = setInterval(sweepExpired, 5000);
};
const stopSweepTimer = () => {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
};

/* -------------------------------------------------------------------------- */
/* RAM-only store for View-Once                                               */
/* -------------------------------------------------------------------------- */

/**
 * View-Once payloads live here and nowhere else: no SQLite row, no AsyncStorage
 * entry, no journal. They die on burn, on app background, on lock, and with the
 * process. A 10-minute unopened ceiling caps how long an unread one can sit in
 * memory waiting to be captured by a heap dump.
 */
export const RamVault = (() => {
  const store = new Map<string, StoredMessage & { unopenedUntil: number }>();
  const UNOPENED_CEILING_MS = 600_000;

  return {
    put(msg: StoredMessage): StoredMessage {
      store.set(msg.id, { ...msg, unopenedUntil: Date.now() + UNOPENED_CEILING_MS });
      return msg;
    },
    get: (id: string): StoredMessage | undefined => store.get(id),
    byThread: (threadId: string): StoredMessage[] =>
      [...store.values()]
        .filter((m) => m.thread_id === threadId)
        .sort((a, b) => a.created_at - b.created_at),
    /** Irreversible. Called the instant the user's finger leaves the bubble. */
    burn(id: string): void {
      const m = store.get(id);
      if (m) m.body = ''; // drop the string reference before unlinking the entry
      store.delete(id);
    },
    sweep(): number {
      const now = Date.now();
      let n = 0;
      for (const [id, m] of store) {
        if (m.unopenedUntil <= now) {
          this.burn(id);
          n++;
        }
      }
      return n;
    },
    purgeAll(): void {
      for (const id of [...store.keys()]) this.burn(id);
    },
    get size(): number {
      return store.size;
    },
  };
})();

/* -------------------------------------------------------------------------- */
/* Panic wipe                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Destroys the primary vault, rotates the device salt (rendering any imaged
 * copy of the old file permanently un-derivable, since the salt is gone from
 * the keystore), and re-provisions a fresh decoy so the app still opens
 * normally afterwards. The absence of a "wiped" state is intentional.
 */
export async function panicWipe(ghostPin: string, ghostFingerprint: string): Promise<void> {
  await lockVault();
  for (const partition of ['primary', 'decoy'] as Partition[]) {
    try {
      driver.open(FILES[partition]).delete();
    } catch {
      /* already gone */
    }
  }
  await Keychain.deleteItem(SALT_KEY);
  await provisionVaults({
    masterPin: toB64(randomBytes(24)), // unreachable by design
    ghostPin,
    primaryFingerprint: '0000 0000 0000 0000 0000',
    ghostFingerprint,
  });
}

export default {
  provisionVaults,
  unlockWithPin,
  lockVault,
  getDb,
  getSession,
  activeMaskIndex,
  insertMessage,
  listMessages,
  markDelivered,
  markReadAndArmTtl,
  sweepExpired,
  panicWipe,
  RamVault,
  setSqlDriver,
  saveRatchet,
  loadRatchet,
  isProvisioned,
  saveSealedMasterSeed,
  loadSealedMasterSeed,
  saveContactRow,
  loadContactRow,
  loadContactRowByFingerprint,
  listContactRows,
  updateContactVerification,
  computeContactFpTag,
};
