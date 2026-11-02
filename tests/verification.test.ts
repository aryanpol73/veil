/**
 * ============================================================================
 *  VEIL — SAFETY NUMBER TESTS (feature F-08)
 * ============================================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMask, generateMasterSeed, safetyNumber } from '../client/src/crypto/keys';

describe('Safety numbers', () => {
  const alice = deriveMask(generateMasterSeed(), 0);
  const bob = deriveMask(generateMasterSeed(), 0);

  it('is 60 digits in 12 groups of five', () => {
    assert.match(safetyNumber(alice, bob), /^(\d{5} ){11}\d{5}$/);
  });

  it('is the same on both phones', () => {
    assert.equal(safetyNumber(alice, bob), safetyNumber(bob, alice));
  });

  it('changes if either identity or exchange key is substituted', () => {
    const base = safetyNumber(alice, bob);
    const mallory = deriveMask(generateMasterSeed(), 0);
    assert.notEqual(safetyNumber(alice, { signPk: bob.signPk, dhPk: mallory.dhPk }), base);
    assert.notEqual(safetyNumber(alice, { signPk: mallory.signPk, dhPk: bob.dhPk }), base);
    assert.notEqual(safetyNumber({ signPk: alice.signPk, dhPk: mallory.dhPk }, bob), base);
  });
});
