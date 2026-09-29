/**
 * ============================================================================
 *  VEIL — RELAY PROTOCOL DEFINITIONS & FRAME BUILDERS
 * ============================================================================
 */

import type { ClientFrame, ServerFrame } from '../types/models';

export type { ClientFrame, ServerFrame };

export const RelayProtocol = {
  createHello(): ClientFrame {
    return { t: 'HELLO', v: 1 };
  },

  createSub(inbox: string, signPk: string, signature: string): ClientFrame {
    return { t: 'SUB', inbox, pk: signPk, sig: signature };
  },

  createUnsub(inbox: string): ClientFrame {
    return { t: 'UNSUB', inbox };
  },

  createSend(inbox: string, env: string): ClientFrame {
    return { t: 'SEND', inbox, env };
  },

  createAck(inbox: string, ids: string[]): ClientFrame {
    return { t: 'ACK', inbox, ids };
  },

  createNoop(): ClientFrame {
    return { t: 'NOOP' };
  },

  createPing(): ClientFrame {
    return { t: 'PING' };
  },

  parseServerFrame(data: string): ServerFrame | null {
    try {
      const obj = JSON.parse(data);
      if (!obj || typeof obj.t !== 'string') return null;
      return obj as ServerFrame;
    } catch {
      return null;
    }
  },
};

export default RelayProtocol;
