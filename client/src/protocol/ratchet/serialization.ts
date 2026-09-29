/**
 * ============================================================================
 *  VEIL — DOUBLE RATCHET SERIALIZATION
 * ============================================================================
 *  Bridges DoubleRatchetState with the encrypted persistence layer in db.ts.
 * ============================================================================
 */

import type { RatchetState as StoredRatchetState, StoredSkippedKey } from '../../storage/db';
import type { DoubleRatchetState, SkippedKeyEntry } from './state';

export function toStoredRatchet(state: DoubleRatchetState): StoredRatchetState {
  const skippedList: StoredSkippedKey[] = [];
  if (state.skippedKeys) {
    for (const [id, entry] of state.skippedKeys) {
      skippedList.push({
        id,
        remoteDhPkHex: entry.remoteDhPkHex,
        counter: entry.counter,
        messageKey: entry.messageKey,
        createdAt: entry.createdAt,
      });
    }
  }

  return {
    rootKey: state.rootKey,
    sendChainKey: state.sendChainKey,
    recvChainKey: state.recvChainKey,
    sendDhSk: state.localDhSk,
    sendDhPk: state.localDhPk,
    recvDhPk: state.remoteDhPk,
    sendCounter: state.sendCounter,
    recvCounter: state.recvCounter,
    prevChainLen: state.prevChainLen,
    skippedKeys: skippedList,
  };
}

export function fromStoredRatchet(
  stored: StoredRatchetState,
  skippedKeys?: Map<string, any>,
): DoubleRatchetState {
  const rootKey = stored.rootKey ?? stored.root_key;
  const sendChainKey =
    stored.sendChainKey !== undefined ? stored.sendChainKey : (stored.send_chain_key ?? null);
  const recvChainKey =
    stored.recvChainKey !== undefined ? stored.recvChainKey : (stored.recv_chain_key ?? null);
  const localDhSk = stored.sendDhSk ?? stored.send_dh_sk;
  const localDhPk = stored.sendDhPk ?? stored.send_dh_pk;
  const remoteDhPk =
    stored.recvDhPk !== undefined ? stored.recvDhPk : (stored.recv_dh_pk ?? null);
  const sendCounter = stored.sendCounter ?? stored.send_counter ?? 0;
  const recvCounter = stored.recvCounter ?? stored.recv_counter ?? 0;
  const prevChainLen = stored.prevChainLen ?? stored.prev_chain_len ?? 0;

  if (!rootKey || !localDhSk || !localDhPk) {
    throw new Error('[veil/ratchet] invalid stored ratchet state: missing core keys');
  }

  const restoredSkipped = new Map<string, SkippedKeyEntry>();
  const sourceSkipped = stored.skippedKeys ?? stored.skipped_keys;
  if (sourceSkipped && Array.isArray(sourceSkipped)) {
    for (const entry of sourceSkipped) {
      restoredSkipped.set(entry.id, {
        remoteDhPkHex: entry.remoteDhPkHex ?? '',
        counter: entry.counter,
        messageKey: new Uint8Array(entry.messageKey),
        createdAt: entry.createdAt,
      });
    }
  } else if (skippedKeys) {
    for (const [k, v] of skippedKeys) {
      restoredSkipped.set(k, v);
    }
  }

  return {
    rootKey: new Uint8Array(rootKey),
    sendChainKey: sendChainKey ? new Uint8Array(sendChainKey) : null,
    recvChainKey: recvChainKey ? new Uint8Array(recvChainKey) : null,
    localDhSk: new Uint8Array(localDhSk),
    localDhPk: new Uint8Array(localDhPk),
    remoteDhPk: remoteDhPk ? new Uint8Array(remoteDhPk) : null,
    sendCounter,
    recvCounter,
    prevChainLen,
    skippedKeys: restoredSkipped,
  };
}

export default {
  toStoredRatchet,
  fromStoredRatchet,
};
