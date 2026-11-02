/**
 * Real SQLite driver for Node tests, backed by the built-in `node:sqlite`.
 *
 * Unlike `memoryDriver` (a regex-matching Map used for web preview), this runs
 * the actual schema: CHECK constraints, foreign keys, transactions, INSERT OR
 * IGNORE and so on. It has no SQLCipher, so `requiresCipher` is false and the
 * vault relies on field-level AEAD here, exactly as on web preview.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlConnection, SqlDriver, SqlResult } from '../../client/src/storage/db';

export interface NodeSqliteDriver extends SqlDriver {
  /** Removes every database file this driver created. */
  dispose(): void;
}

export function createNodeSqliteDriver(): NodeSqliteDriver {
  const dir = mkdtempSync(join(tmpdir(), 'veil-test-'));

  return {
    requiresCipher: false,

    open(name: string): SqlConnection {
      const path = join(dir, name);
      let db: DatabaseSync | null = new DatabaseSync(path);

      const conn = (): DatabaseSync => {
        if (!db) throw new Error('[test/sqlite] connection closed');
        return db;
      };

      return {
        execute<T = any>(sql: string, params: any[] = []): SqlResult<T> {
          const stmt = conn().prepare(sql);
          const trimmed = sql.trim();
          if (/^(SELECT|WITH|PRAGMA)\b/i.test(trimmed)) {
            return { rows: stmt.all(...params) as T[], rowsAffected: 0 };
          }
          const r = stmt.run(...params);
          return {
            rows: [],
            rowsAffected: Number(r.changes),
            insertId: Number(r.lastInsertRowid),
          };
        },
        transaction(fn: () => void): void {
          const d = conn();
          d.exec('BEGIN');
          try {
            fn();
            d.exec('COMMIT');
          } catch (err) {
            d.exec('ROLLBACK');
            throw err;
          }
        },
        close(): void {
          db?.close();
          db = null;
        },
        delete(): void {
          try {
            db?.close();
          } catch {
            /* ignore */
          }
          db = null;
          for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
        },
      };
    },

    dispose(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
