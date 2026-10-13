import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WEAPONS,
  WeaponId,
  getWeapon,
  hasAmmo,
  isReadyToFire,
  isUnlocked,
} from '../src/weapons.ts';
import { CRATE_CONFIG } from '../src/balance.config.ts';

test('table has one entry per WeaponId and ids match indices', () => {
  assert.equal(WEAPONS.length, 9);
  WEAPONS.forEach((def, index) => {
    assert.equal(def.id, index, `weapon at index ${index} has id ${def.id}`);
  });
  assert.equal(getWeapon(WeaponId.Pistol).name, 'Pistol');
  assert.equal(getWeapon(WeaponId.Shotgun).name, 'Shotgun');
  assert.equal(getWeapon(WeaponId.Railgun).name, 'Railgun');
  assert.equal(getWeapon(WeaponId.Crate).name, 'Crate');
});

test('every weapon has sane stats', () => {
  const validKinds = new Set(['hitscan', 'projectile', 'deployable']);
  for (const def of WEAPONS) {
    assert.ok(validKinds.has(def.kind), `${def.name}: bad kind`);
    assert.ok(def.damage > 0, `${def.name}: damage`);
    assert.ok(def.fireIntervalMs > 0, `${def.name}: fire interval`);
    assert.ok(Number.isInteger(def.magSize) && def.magSize >= 0, `${def.name}: mag size`);
    assert.ok(Number.isInteger(def.pelletCount) && def.pelletCount >= 1, `${def.name}: pellets`);
    assert.ok(def.spread >= 0, `${def.name}: spread`);
    assert.ok(def.maxRange >= 0 && def.projectileSpeed >= 0, `${def.name}: range/speed`);
    assert.ok(def.explosionRadius >= 0, `${def.name}: radius`);
    assert.ok(Number.isInteger(def.comboTier) && def.comboTier >= 0 && def.comboTier <= 5,
      `${def.name}: combo tier`);
    if (def.kind === 'hitscan') assert.ok(def.maxRange > 0, `${def.name}: hitscan needs range`);
    if (def.kind === 'projectile') assert.ok(def.projectileSpeed > 0, `${def.name}: needs speed`);
  }
});

test('hitscan bullets have a finite range and bounded falloff', () => {
  for (const def of WEAPONS) {
    assert.ok(Number.isFinite(def.maxRange), `${def.name}: range must be finite`);
    assert.ok(def.damageFalloff >= 0 && def.damageFalloff < 1, `${def.name}: falloff out of [0,1)`);
    if (def.kind === 'hitscan') {
      assert.ok(def.maxRange > 0, `${def.name}: hitscan needs a finite range`);
    }
  }
  // starter weapons cannot reach across the 40-unit arena diagonal
  assert.ok(getWeapon(WeaponId.Pistol).maxRange < 40, 'pistol range stays inside the arena');
  assert.ok(getWeapon(WeaponId.Uzi).maxRange < 40, 'uzi range stays inside the arena');
  // the shotgun is the shortest-ranged weapon with the harshest falloff
  assert.ok(getWeapon(WeaponId.Shotgun).maxRange < getWeapon(WeaponId.Pistol).maxRange);
  assert.ok(
    getWeapon(WeaponId.Shotgun).damageFalloff > getWeapon(WeaponId.Pistol).damageFalloff
  );
});

test('pistol is the infinite-ammo starter, railgun pierces', () => {
  const pistol = getWeapon(WeaponId.Pistol);
  assert.equal(pistol.magSize, 0);
  assert.equal(pistol.comboTier, 0);
  assert.equal(getWeapon(WeaponId.Railgun).pierce, true);
});

test('wooden crate: infinite-stock deployable that never explodes', () => {
  const crate = getWeapon(WeaponId.Crate);
  assert.equal(crate.kind, 'deployable');
  assert.equal(crate.magSize, 0, 'infinite stock — the cadence limits building');
  assert.equal(crate.explosionRadius, 0, 'crates have no blast');
  assert.equal(crate.comboTier, 1, 'fortification is available early');
  assert.equal(CRATE_CONFIG.hp, 150, 'crates take 150 HP to claw down');
  assert.equal(CRATE_CONFIG.explodes, false, 'a destroyed crate only splinters');
  // the placement cadence keeps wall-building from becoming instant spam
  assert.ok(crate.fireIntervalMs >= 1000);
});

test('getWeapon rejects unknown ids', () => {
  assert.throws(() => getWeapon(99), /unknown weapon id/);
  assert.throws(() => getWeapon(-1), /unknown weapon id/);
  assert.throws(() => getWeapon(1.5), /unknown weapon id/);
});

test('combo tier gating', () => {
  const shotgun = getWeapon(WeaponId.Shotgun);
  assert.equal(isUnlocked(shotgun, 0), false);
  assert.equal(isUnlocked(shotgun, 1), true);
  assert.equal(isUnlocked(getWeapon(WeaponId.Pistol), 0), true);
  assert.equal(isUnlocked(getWeapon(WeaponId.Railgun), 5), true);
});

test('rate of fire is enforced at the exact boundary', () => {
  const shotgun = getWeapon(WeaponId.Shotgun); // 900 ms
  assert.equal(isReadyToFire(shotgun, 800, 0), false);
  assert.equal(isReadyToFire(shotgun, 899, 0), false);
  assert.equal(isReadyToFire(shotgun, 900, 0), true);
  assert.equal(isReadyToFire(shotgun, 5000, 4500), false); // only 500 ms elapsed
  assert.equal(isReadyToFire(shotgun, 5400, 4500), true); // exactly 900 ms elapsed
  assert.equal(isReadyToFire(shotgun, 4499, 4500), false);
});

test('ammo checks honour the infinite magazine', () => {
  const pistol = getWeapon(WeaponId.Pistol);
  const shotgun = getWeapon(WeaponId.Shotgun);
  assert.equal(hasAmmo(pistol, 0), true);
  assert.equal(hasAmmo(shotgun, 0), false);
  assert.equal(hasAmmo(shotgun, 1), true);
});
