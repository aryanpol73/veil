/**
 * ============================================================================
 *  VEIL — DECOY TELL GUARD (audit A-04, A-05, A-06)
 * ============================================================================
 *  Static checks over the post-setup UI source. Any user-visible string that
 *  names the duress feature would let a coercer learn a second vault exists.
 *  ProvisionScreen is exempt: setup is where the feature is explained.
 * ============================================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, isValidPinLength } from '../client/src/storage/pinPolicy';

const CLIENT = join(__dirname, '..', 'client');
const POST_SETUP_FILES = [
  join(CLIENT, 'App.tsx'),
  ...['UnlockScreen.tsx', 'ThreadListScreen.tsx', 'ChatScreen.tsx', 'VerifyScreen.tsx'].map((f) =>
    join(CLIENT, 'src', 'screens', f),
  ),
  ...readdirSync(join(CLIENT, 'src', 'components'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => join(CLIENT, 'src', 'components', f)),
];

/** Source with comments removed and the PrismButton "ghost" style variant masked. */
function visibleSource(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/variant=["']ghost["']/g, '')
    .replace(/case 'ghost'/g, '')
    .replace(/'ghost'/g, '');
}

describe('Decoy tells in post-setup UI', () => {
  for (const file of POST_SETUP_FILES) {
    it(`${file.split(/[\\/]/).pop()} names no duress feature`, () => {
      const src = visibleSource(file);
      const hit = src.match(/ghost|decoy|duress|partition/i);
      assert.equal(hit, null, `found "${hit?.[0]}" in ${file}`);
    });
  }

  it('unlock and setup share one PIN length policy', () => {
    const unlock = readFileSync(join(CLIENT, 'src', 'screens', 'UnlockScreen.tsx'), 'utf8');
    const provision = readFileSync(join(CLIENT, 'src', 'screens', 'ProvisionScreen.tsx'), 'utf8');
    for (const src of [unlock, provision]) {
      assert.match(src, /maxLength=\{PIN_MAX_LENGTH\}/);
      assert.doesNotMatch(src, /maxLength=\{\d+\}/);
    }
    assert.doesNotMatch(unlock, /length === 6/);
    for (let n = PIN_MIN_LENGTH; n <= PIN_MAX_LENGTH; n++) {
      assert.equal(isValidPinLength('1'.repeat(n)), true);
    }
  });
});
