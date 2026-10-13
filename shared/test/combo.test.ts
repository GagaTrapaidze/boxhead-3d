import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_MULTIPLIER,
  WEAPON_MULTIPLIER_REQUIREMENT,
  comboMilestoneLabel,
  comboMilestones,
  comboWindowSeconds,
  isComboMilestone,
  isUnlockedByMultiplier,
  multiplierAfterKill,
  requiredMultiplierFor,
  resetMultiplier,
} from '../src/combo.ts';
import { WEAPONS } from '../src/weapons.ts';

test('spec weapon tier order: shotgun → uzi → grenade → barrel → rocket → railgun', () => {
  const ladder = [1, 2, 3, 4, 6, 7]; // shotgun, uzi, grenade, barrel, rocket, railgun
  const requirements = ladder.map((id) => requiredMultiplierFor(id));
  for (let i = 1; i < requirements.length; i++) {
    assert.ok(
      requirements[i] > requirements[i - 1],
      `tier ${i} must require a higher multiplier than ${i - 1}`
    );
  }
  assert.equal(requiredMultiplierFor(0), 0, 'pistol is the starter weapon');
});

test('every weapon in the table has a multiplier requirement', () => {
  for (const def of WEAPONS) {
    const required = requiredMultiplierFor(def.id);
    assert.ok(Number.isInteger(required) && required >= 0, def.name);
  }
  assert.throws(() => requiredMultiplierFor(99), /unknown weapon id/);
  assert.throws(() => requiredMultiplierFor(-1), /unknown weapon id/);
});

test('kills add +1, damage resets to base', () => {
  assert.equal(BASE_MULTIPLIER, 1);
  assert.equal(multiplierAfterKill(1), 2);
  assert.equal(multiplierAfterKill(7), 8);
  assert.equal(resetMultiplier(), 1);
});

test('classic combo: one flat hold window, refreshed on every kill', () => {
  // Unlike a per-tier decay, every kill holds the SAME 1.8 s window; when it
  // lapses the chain resets straight to ×1 (all-or-nothing).
  assert.equal(comboWindowSeconds(), 1.8);
  assert.equal(comboWindowSeconds(), comboWindowSeconds());
});

test('milestones drive the spree feedback', () => {
  assert.deepEqual([...comboMilestones()], [10, 25, 50]);
  assert.equal(isComboMilestone(10), true);
  assert.equal(isComboMilestone(25), true);
  assert.equal(isComboMilestone(9), false);
  assert.equal(isComboMilestone(11), false);
  assert.equal(comboMilestoneLabel(10), '×10 SPREE!');
  assert.equal(comboMilestoneLabel(25), '×25 UNSTOPPABLE!');
  assert.equal(comboMilestoneLabel(50), '×50 GODLIKE!');
  assert.equal(comboMilestoneLabel(7), null);
});

test('unlock gating flips exactly at the requirement', () => {
  const shotgun = 1;
  const required = requiredMultiplierFor(shotgun);
  assert.equal(isUnlockedByMultiplier(shotgun, required - 1), false);
  assert.equal(isUnlockedByMultiplier(shotgun, required), true);
  assert.equal(isUnlockedByMultiplier(0, 1), true, 'pistol always usable');
  // sanity: the spec ladder maps onto the shared weapon table names
  assert.equal(WEAPONS[shotgun].name, 'Shotgun');
  assert.equal(WEAPONS[7].name, 'Railgun');
});
