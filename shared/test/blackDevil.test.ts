import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECTOR_CONFIG,
  ENEMY_CONFIG,
  GRENADE_CONFIG,
  PLAYER_CONFIG,
  SHOCKWAVE_EXPANSION_SPEED,
  WAVE_CONFIG,
} from '../src/balance.config.ts';
import { ringSweepHitsCircle } from '../src/shockwave.ts';
import {
  CURSE_CLEANSE_SECONDS,
  CURSE_DAMAGE,
  CURSE_TICK_INTERVAL,
  advanceCurse,
  canApplyCurse,
  createCurseState,
  curseProgress,
} from '../src/curse.ts';
import {
  DROP_KINDS,
  ENEMY_KINDS,
  bossLootCount,
  dropKindCode,
  enemyKindCode,
  enemyKindFromCode,
  pickBossLoot,
  pickDropKind,
  rollDropKind,
} from '../src/loot.ts';

const BLACK = ENEMY_CONFIG.blackDevil;

test('Black Devil boss: 1200 HP and a body larger than the red Devil', () => {
  assert.equal(BLACK.hp, 1200, 'the boss has 1200 HP');
  assert.ok(BLACK.radius > ENEMY_CONFIG.devil.radius, 'the boss is physically larger');
  assert.ok(BLACK.score > ENEMY_CONFIG.devil.score, 'the boss is worth more');
});

test('Black Devil explosive armor: one blast never kills, three do', () => {
  const cap = BLACK.explosiveDamageCap;
  assert.ok(cap > 0, 'the boss needs a positive explosive cap');
  assert.ok(GRENADE_CONFIG.damage > cap, 'raw grenade damage exceeds the boss cap');
  assert.ok(BLACK.hp > 2 * cap, `two blasts must NOT kill it (hp ${BLACK.hp} > ${2 * cap})`);
  assert.ok(BLACK.hp <= 3 * cap, `three blasts must kill it (hp ${BLACK.hp} <= ${3 * cap})`);
});

test('Black Devil radial shockwave: 4 u ring, 3 u trigger, 4.5 s cooldown', () => {
  assert.equal(BLACK.shockwaveRadius, 4, 'the ring expands to a 4-block radius');
  assert.equal(BLACK.shockwaveCooldown, 4.5, 'strict 4.5 s internal cooldown');
  assert.equal(BLACK.shockwaveTriggerRange, 3, 'any player inside 3 u triggers it');
  assert.ok(
    BLACK.shockwaveTriggerRange < BLACK.shockwaveRadius,
    'the trigger sits inside the blast so the ring always lands'
  );
  assert.ok(BLACK.shockwaveDamage > 0, 'the shockwave deals flat damage');
});

test('Black Devil laser: 1 s telegraph + 3.5 s channel with dodgeable inertia', () => {
  assert.equal(BLACK.laserTelegraph, 1.0, 'telegraph phase is 1 second');
  assert.equal(BLACK.laserDuration, 3.5, 'beam phase is 3.5 seconds');
  assert.ok(BLACK.laserCooldown > 0, 'the laser has a cooldown between channels');
  assert.ok(BLACK.laserRange > 0 && BLACK.laserHalfWidth > 0, 'the beam has reach and width');
  assert.ok(BLACK.laserDamage > 0, 'the beam ticks damage');
  assert.ok(BLACK.laserTickInterval > 0, 'damage ticks on an interval');
  // Rotational inertia must be slow enough that a player can sprint/strafe out:
  // out-turning a 9 u/s sprint at mid range needs well under ~1.5 rad/s of turn.
  assert.ok(
    BLACK.laserTurnRate < PLAYER_CONFIG.speed / 3,
    `turn rate ${BLACK.laserTurnRate} rad/s is dodgeable against a ${PLAYER_CONFIG.speed} u/s sprint`
  );
});

test('Black Devil spinner: 4-cube volley travels toward the target', () => {
  assert.ok(BLACK.spinnerSpeed > 0, 'the spinner travels');
  assert.ok(BLACK.spinnerLife > 0, 'the spinner expires');
  assert.ok(BLACK.spinnerDamage > 0, 'the spinner hits for damage');
  assert.ok(BLACK.spinnerInterval > 0, 'volleys are paced');
  assert.ok(BLACK.spinnerSpinRate > 0, 'the orbit visibly rotates');
  assert.ok(
    BLACK.spinnerTurnRate > 0 && BLACK.spinnerTurnRate < 2,
    'the spinner barely steers, so it can be side-stepped'
  );
});

test('Wave 7 hosts the boss with the standard horde halved', () => {
  assert.equal(DIRECTOR_CONFIG.blackDevilWave, 7, 'the boss encounter is wave 7');
  assert.equal(DIRECTOR_CONFIG.blackDevilMobCountMultiplier, 0.5, 'small mobs are reduced by 50%');
  // The encounter must not collide with a themed wave event (waves 4/8/12…).
  assert.notEqual(DIRECTOR_CONFIG.blackDevilWave % 4, 0, 'wave 7 is not a themed event wave');
});

test('Black Devil loot explosion: 3–4 rewards drawn from the boss table', () => {
  assert.equal(BLACK.lootDropMin, 3);
  assert.equal(BLACK.lootDropMax, 4);
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const count = bossLootCount();
    assert.ok(count >= BLACK.lootDropMin && count <= BLACK.lootDropMax, `count ${count} in range`);
    seen.add(pickBossLoot());
  }
  for (const kind of seen) assert.ok(DROP_KINDS.includes(kind as never), `${kind} is a real drop kind`);
  assert.ok(seen.has('health'), 'boss loot includes health packs');
});

test('health packs are boss-only and stay out of the normal drop table', () => {
  assert.ok((DROP_KINDS as readonly string[]).includes('health'));
  for (let i = 0; i < 2000; i++) {
    assert.notEqual(pickDropKind(), 'health', 'normal mobs never drop a health pack');
    assert.notEqual(rollDropKind(), 'health', 'the horde drop roll never yields health');
  }
  assert.ok(WAVE_CONFIG.healthRestore > 0, 'a health pack restores HP');
});

test('enemy / drop wire codes stay stable and round-trip', () => {
  assert.equal(ENEMY_KINDS[enemyKindCode('blackDevil')], 'blackDevil');
  assert.equal(enemyKindFromCode(enemyKindCode('blackDevil')), 'blackDevil');
  assert.equal(enemyKindCode('walker'), 0);
  assert.equal(enemyKindCode('runner'), 1);
  assert.equal(enemyKindCode('devil'), 2);
  assert.equal(enemyKindCode('blackDevil'), 3, 'appended, never reordered');
  assert.equal(DROP_KINDS[dropKindCode('health')], 'health');
  assert.equal(dropKindCode('health'), DROP_KINDS.length - 1, 'appended after the standard kinds');
});

test('shockwave expansion speed is a single exported tuning knob', () => {
  assert.ok(SHOCKWAVE_EXPANSION_SPEED > 0, 'the expansion speed is exposed and positive');
  assert.equal(
    BLACK.shockwaveExpansionSpeed,
    SHOCKWAVE_EXPANSION_SPEED,
    'the boss config reuses the shared expansion-speed constant'
  );
  assert.ok(
    BLACK.shockwaveRingThickness > 0,
    'the ring has a contact thickness so "touching" the body can be tested'
  );
});

test('ring geometry: damage only when the expanding perimeter touches the body', () => {
  // Boss at the origin; a body of radius 0.4 sitting 2.0 u away.
  const bodyX = 2.0;
  const bodyRadius = 0.4;
  // Ring still short of the body's near edge (1.6 u) → no contact.
  assert.equal(
    ringSweepHitsCircle(0, 0, 0.6, 0.9, 0.5, bodyX, 0, bodyRadius),
    false,
    'a ring inside the body does not touch it'
  );
  // The perimeter sweeps across the body's distance → contact this step.
  assert.equal(
    ringSweepHitsCircle(0, 0, 1.4, 1.8, 0.5, bodyX, 0, bodyRadius),
    true,
    'the swept perimeter touches the body'
  );
  // A myopic "inside the final radius" test would still say true here, but the
  // perimeter is far past the body and must NOT re-hit it.
  assert.equal(
    ringSweepHitsCircle(0, 0, 80, 81, 0.5, bodyX, 0, bodyRadius),
    false,
    'a ring that already passed the body does not hit it again'
  );
});

test('curse guards: solo immunity, one curse at a time and the respawn window', () => {
  const base = {
    playerCount: 2,
    activeCursedId: '',
    targetId: 'p2',
    targetAlive: true,
    anyPlayerDowned: false,
  };
  assert.equal(canApplyCurse(base), true, 'an ordinary co-op hit may curse');
  assert.equal(canApplyCurse({ ...base, playerCount: 1 }), false, 'solo runs never curse');
  assert.equal(canApplyCurse({ ...base, activeCursedId: 'p1' }), false, 'only one active curse');
  assert.equal(
    canApplyCurse({ ...base, activeCursedId: 'p2' }),
    true,
    're-applying to the current holder keeps the curse'
  );
  assert.equal(
    canApplyCurse({ ...base, anyPlayerDowned: true }),
    false,
    'the respawn / revive window blocks every player'
  );
  assert.equal(canApplyCurse({ ...base, targetAlive: false }), false, 'a downed body is never cursed');
});

test('curse runtime: a 1 s damage cadence and a continuous 3 s cleanse', () => {
  const state = createCurseState();
  // No damage before the first full interval elapses.
  assert.equal(advanceCurse(state, CURSE_TICK_INTERVAL - 0.05, false).damage, 0);
  // Crossing the interval deals exactly one tick.
  assert.equal(advanceCurse(state, 0.1, false).damage, CURSE_DAMAGE);
  // A teammate outside the circle never advances the cleanse hold.
  advanceCurse(state, 0.5, false);
  assert.equal(curseProgress(state), 0, 'the cleanse hold resets without a teammate inside');
  // A continuous hold accumulates until the cleanse completes.
  let cleansed = false;
  for (let t = 0; t < CURSE_CLEANSE_SECONDS * 4 && !cleansed; t += 0.25) {
    cleansed = advanceCurse(state, 0.25, true).cleansed;
  }
  assert.ok(cleansed, 'a continuous 3 s hold completes the cleanse');
  assert.equal(curseProgress(state), 1, 'the progress indicator reads full on cleanse');
});
