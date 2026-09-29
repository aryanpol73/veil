import type { SqlDriver, SqlConnection, SqlResult } from './db';

let SQLite: any = null;
let isNative = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RN = require('react-native');
  if (RN?.Platform?.OS === 'android' || RN?.Platform?.OS === 'ios') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SQLite = require('expo-sqlite');
    isNative = typeof SQLite?.openDatabaseSync === 'function';
  }
} catch {
  isNative = false;
}

/**
 * expo-sqlite synchronous driver for native platforms (Android / iOS).
 * Conforms strictly to the SqlDriver / SqlConnection / SqlResult interfaces in db.ts.
 */
export const expoSqliteDriver: SqlDriver = {
  open(name: string): SqlConnection {
    if (!isNative || !SQLite) {
      return memoryDriver.open(name);
    }
    let db: any;
    try {
      db = SQLite.openDatabaseSync(name, { useSQLCipher: true });
    } catch {
      db = SQLite.openDatabaseSync(name);
    }

    return {
      execute<T = any>(sql: string, params: any[] = []): SqlResult<T> {
        const trimmed = sql.trim();
        const isSelect =
          /^(SELECT|WITH)\b/i.test(trimmed) || /^PRAGMA\s+[a-zA-Z0-9_]+$/i.test(trimmed);

        if (isSelect) {
          const rows = db.getAllSync(sql, params as any) as T[];
          return {
            rows: (rows ?? []) as T[],
            rowsAffected: 0,
          };
        } else {
          // If query has multiple statements with no params, execute via execSync
          if (params.length === 0 && sql.includes(';')) {
            db.execSync(sql);
            return {
              rows: [],
              rowsAffected: 0,
            };
          }
          const r = db.runSync(sql, params as any);
          return {
            rows: [],
            rowsAffected: r.changes,
            insertId: r.lastInsertRowId,
          };
        }
      },

      transaction(fn: () => void): void {
        db.withTransactionSync(fn);
      },

      close(): void {
        db.closeSync();
      },

      delete(): void {
        try {
          db.closeSync();
        } catch {
          /* ignore */
        }
        try {
          SQLite.deleteDatabaseSync(name);
        } catch {
          /* ignore */
        }
      },
    };
  },
};

/* -------------------------------------------------------------------------- */
/* In-memory Map-backed stub driver for web preview                           */
/* -------------------------------------------------------------------------- */

interface MemoryDbState {
  meta: Map<string, string>;
  masks: Map<number, any>;
  contacts: Map<string, any>;
  threads: Map<string, any>;
  ratchets: Map<string, any>;
  messages: Map<string, any>;
  ballast: any[];
  pageCount: number;
}

const memoryStore = new Map<string, MemoryDbState>();

function getOrCreateMemoryDb(name: string): MemoryDbState {
  let state = memoryStore.get(name);
  if (!state) {
    state = {
      meta: new Map(),
      masks: new Map(),
      contacts: new Map(),
      threads: new Map(),
      ratchets: new Map(),
      messages: new Map(),
      ballast: [],
      pageCount: 16,
    };
    memoryStore.set(name, state);
  }
  return state;
}

/**
 * In-memory Map-backed driver for web preview so that wa-sqlite / OPFS
 * bundler setup is not required to preview the application in the browser.
 */
export const memoryDriver: SqlDriver = {
  open(name: string): SqlConnection {
    const mem = getOrCreateMemoryDb(name);

    return {
      execute<T = any>(sql: string, params: any[] = []): SqlResult<T> {
        const trimmed = sql.trim();

        // 1. PRAGMAs
        if (/^PRAGMA\s+page_count/i.test(trimmed)) {
          return { rows: [{ page_count: mem.pageCount }] as any, rowsAffected: 0 };
        }
        if (/^PRAGMA/i.test(trimmed)) {
          return { rows: [], rowsAffected: 0 };
        }

        // 2. DDL & Index statements
        if (/^(CREATE|DROP|ALTER)\b/i.test(trimmed)) {
          return { rows: [], rowsAffected: 0 };
        }

        // 3. sqlite_master check
        if (/FROM\s+sqlite_master/i.test(trimmed)) {
          return { rows: [{ 'count(*)': 1 }] as any, rowsAffected: 0 };
        }

        // 4. meta table
        if (/INSERT\s+(OR\s+(IGNORE|REPLACE)\s+)?INTO\s+meta/i.test(trimmed)) {
          const key = String(params[0]);
          const val = String(params[1]);
          if (/IGNORE/i.test(trimmed)) {
            if (!mem.meta.has(key)) mem.meta.set(key, val);
          } else {
            mem.meta.set(key, val);
          }
          return { rows: [], rowsAffected: 1 };
        }

        if (/SELECT\s+(value|\*)\s+FROM\s+meta\s+WHERE\s+key\s*=\s*\?/i.test(trimmed)) {
          const key = String(params[0]);
          const val = mem.meta.get(key);
          if (val !== undefined) {
            return { rows: [{ value: val }] as any, rowsAffected: 0 };
          }
          return { rows: [], rowsAffected: 0 };
        }

        // 5. masks table
        if (/INSERT\s+(OR\s+REPLACE\s+)?INTO\s+masks/i.test(trimmed)) {
          mem.masks.set(params[0], {
            mask_index: params[0],
            label: params[1],
            fingerprint: params[2],
            created_at: params[3],
          });
          return { rows: [], rowsAffected: 1 };
        }

        // 6. contacts table
        if (/INSERT\s+(OR\s+REPLACE\s+)?INTO\s+contacts/i.test(trimmed)) {
          const hasFpTag = params.length >= 9;
          mem.contacts.set(params[0], {
            id: params[0],
            mask_index: params[1],
            alias: params[2],
            sign_pk: params[3],
            dh_pk: params[4],
            fingerprint: params[5],
            fp_tag: hasFpTag ? params[6] : undefined,
            verified_at: hasFpTag ? params[7] : params[6],
            created_at: hasFpTag ? params[8] : params[7],
          });
          return { rows: [], rowsAffected: 1 };
        }

        if (/SELECT\s+\*\s+FROM\s+contacts\s+WHERE\s+id\s*=\s*\?/i.test(trimmed)) {
          const c = mem.contacts.get(params[0]);
          return { rows: c ? ([c] as any) : [], rowsAffected: 0 };
        }

        if (/SELECT\s+\*\s+FROM\s+contacts\s+WHERE\s+(fp_tag|fingerprint)\s*=\s*\?/i.test(trimmed)) {
          const matched = [...mem.contacts.values()].filter(
            (c) => c.fp_tag === params[0] || c.fingerprint === params[0],
          );
          return { rows: matched as any, rowsAffected: 0 };
        }

        if (/SELECT\s+\*\s+FROM\s+contacts/i.test(trimmed)) {
          const all = [...mem.contacts.values()].sort((a, b) => b.created_at - a.created_at);
          return { rows: all as any, rowsAffected: 0 };
        }

        if (/UPDATE\s+contacts\s+SET\s+verified_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?/i.test(trimmed)) {
          const c = mem.contacts.get(params[1]);
          if (c) c.verified_at = params[0];
          return { rows: [], rowsAffected: c ? 1 : 0 };
        }

        // 7. threads table
        if (/INSERT\s+(OR\s+REPLACE\s+)?INTO\s+threads/i.test(trimmed)) {
          mem.threads.set(params[0], {
            id: params[0],
            contact_id: params[1],
            default_retention: params[2],
            last_activity_at: params[3],
            unread_count: params[4],
          });
          return { rows: [], rowsAffected: 1 };
        }

        if (/SELECT\s+\*\s+FROM\s+threads\s+WHERE\s+id\s*=\s*\?/i.test(trimmed)) {
          const th = mem.threads.get(params[0]);
          return { rows: th ? ([th] as any) : [], rowsAffected: 0 };
        }

        if (/SELECT\s+\*\s+FROM\s+threads/i.test(trimmed)) {
          const all = [...mem.threads.values()].sort((a, b) => b.last_activity_at - a.last_activity_at);
          return { rows: all as any, rowsAffected: 0 };
        }

        if (
          /UPDATE\s+threads\s+SET\s+last_activity_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?/i.test(
            trimmed,
          )
        ) {
          const th = mem.threads.get(params[1]);
          if (th) th.last_activity_at = params[0];
          return { rows: [], rowsAffected: 1 };
        }

        if (
          /UPDATE\s+threads\s+SET\s+unread_count\s*=\s*1\s+WHERE\s+id\s*=\s*\?/i.test(
            trimmed,
          )
        ) {
          const th = mem.threads.get(params[0]);
          if (th) th.unread_count = 1;
          return { rows: [], rowsAffected: 1 };
        }

        // 8. ratchets table
        if (/INSERT\s+(OR\s+REPLACE\s+)?INTO\s+ratchets/i.test(trimmed)) {
          mem.ratchets.set(params[0], {
            thread_id: params[0],
            root_key: params[1],
            send_chain_key: params[2],
            recv_chain_key: params[3],
            send_dh_sk: params[4],
            send_dh_pk: params[5],
            recv_dh_pk: params[6],
            send_counter: params[7],
            recv_counter: params[8],
            prev_chain_len: params[9],
            skipped_keys: params[10],
          });
          return { rows: [], rowsAffected: 1 };
        }

        if (/SELECT\s+\*\s+FROM\s+ratchets\s+WHERE\s+thread_id\s*=\s*\?/i.test(trimmed)) {
          const r = mem.ratchets.get(params[0]);
          return { rows: r ? ([r] as any) : [], rowsAffected: 0 };
        }

        // 9. messages table
        if (/INSERT\s+(OR\s+REPLACE\s+)?INTO\s+messages/i.test(trimmed)) {
          const isDecoy = /delivered_at/i.test(trimmed);
          if (isDecoy) {
            mem.messages.set(params[0], {
              id: params[0],
              thread_id: params[1],
              direction: params[2],
              retention: params[3],
              body: params[4],
              created_at: params[5],
              delivered_at: params[6],
              read_at: params[7],
              counter: params[8] ?? 0,
              expires_at: null,
              ttl_ms: null,
            });
          } else {
            mem.messages.set(params[0], {
              id: params[0],
              thread_id: params[1],
              direction: params[2],
              retention: params[3],
              body: params[4],
              created_at: params[5],
              expires_at: params[6],
              ttl_ms: params[7],
              counter: params[8] ?? 0,
              delivered_at: null,
              read_at: null,
            });
          }
          return { rows: [], rowsAffected: 1, insertId: mem.messages.size };
        }

        if (
          /SELECT\s+\*\s+FROM\s+messages\s+WHERE\s+thread_id\s*=\s*\?/i.test(
            trimmed,
          )
        ) {
          const threadId = params[0];
          const now = params[1] ?? Date.now();
          const limit = params[2] ?? 200;
          const matched = [...mem.messages.values()]
            .filter(
              (m) =>
                m.thread_id === threadId &&
                (m.expires_at == null || m.expires_at > now),
            )
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, limit);
          return { rows: matched as any, rowsAffected: 0 };
        }

        if (/SELECT\s+\*\s+FROM\s+messages\s+WHERE\s+id\s*=\s*\?/i.test(trimmed)) {
          const m = mem.messages.get(params[0]);
          return { rows: m ? ([m] as any) : [], rowsAffected: 0 };
        }

        if (
          /UPDATE\s+messages\s+SET\s+delivered_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?/i.test(
            trimmed,
          )
        ) {
          const m = mem.messages.get(params[1]);
          let affected = 0;
          if (m && m.delivered_at == null) {
            m.delivered_at = params[0];
            affected = 1;
          }
          return { rows: [], rowsAffected: affected };
        }

        if (
          /UPDATE\s+messages\s+SET\s+read_at\s*=\s*\?,\s*expires_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?/i.test(
            trimmed,
          )
        ) {
          const m = mem.messages.get(params[2]);
          let affected = 0;
          if (m) {
            m.read_at = params[0];
            m.expires_at = params[1];
            affected = 1;
          }
          return { rows: [], rowsAffected: affected };
        }

        if (
          /DELETE\s+FROM\s+messages\s+WHERE\s+expires_at\s+IS\s+NOT\s+NULL/i.test(
            trimmed,
          )
        ) {
          const exp = params[0];
          let count = 0;
          for (const [id, m] of mem.messages) {
            if (m.expires_at != null && m.expires_at <= exp) {
              mem.messages.delete(id);
              count++;
            }
          }
          return { rows: [], rowsAffected: count };
        }

        // 9. Ballast
        if (/INSERT\s+INTO\s+ballast/i.test(trimmed)) {
          mem.ballast.push(params[0]);
          mem.pageCount += 16;
          return { rows: [], rowsAffected: 1 };
        }

        return { rows: [], rowsAffected: 0 };
      },

      transaction(fn: () => void): void {
        fn();
      },

      close(): void {
        // Keeps memory in store until delete()
      },

      delete(): void {
        memoryStore.delete(name);
      },
    };
  },
};

/**
 * Selects memoryDriver on web (Platform.OS === 'web') and expoSqliteDriver on native.
 */
export const defaultDriver: SqlDriver = isNative ? expoSqliteDriver : memoryDriver;

export default defaultDriver;
