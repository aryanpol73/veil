/**
 * ============================================================================
 *  VEIL — PENDING INVITE (deep links)
 * ============================================================================
 *  A veil://invite link can arrive while the app is locked. It is held here,
 *  in memory only and never on disk, until a vault is open and the thread
 *  list can offer to pair with it. Anything that is not an invite link is
 *  ignored.
 * ============================================================================
 */

const PREFIX = 'veil://invite?';

let pending: string | null = null;
const listeners = new Set<() => void>();

export function setPendingInvite(uri: string | null | undefined): void {
  if (!uri || !uri.startsWith(PREFIX)) return;
  pending = uri;
  for (const l of listeners) l();
}

/** Returns the pending invite once, then forgets it. */
export function takePendingInvite(): string | null {
  const uri = pending;
  pending = null;
  return uri;
}

export function onPendingInvite(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
