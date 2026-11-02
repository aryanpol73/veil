/**
 * ============================================================================
 *  VEIL — PIN POLICY
 * ============================================================================
 *  Single source of truth for PIN length. Provisioning, unlock, and the vault
 *  layer all read these constants so a PIN accepted at setup can always be
 *  entered again at unlock (audit A-04).
 * ============================================================================
 */

export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 8;

/** Strips non-digits and caps at the maximum length. */
export const sanitizePin = (raw: string): string =>
  raw.replace(/\D/g, '').slice(0, PIN_MAX_LENGTH);

export const isValidPinLength = (pin: string): boolean =>
  pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH;
