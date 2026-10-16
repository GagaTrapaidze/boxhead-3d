import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BARREL_CONFIG,
  COOP_CONFIG,
  CRATE_CONFIG,
  DIRECTOR_CONFIG,
  DROP_CONFIG,
  DROP_RATE_MULTIPLIER,
  ENEMY_CONFIG,
  GRENADE_CONFIG,
  JUICE_CONFIG,
  LIZI_SPEED_SLIDER,
  LIZI_STATS,
  PHYSICS_CONFIG,
  PLAYER_CONFIG,
  PISTOL_CONFIG,
  SHOTGUN_CONFIG,
  SPATIAL_CONFIG,
  UZI_CONFIG,
  WAVE_CONFIG,
  WAVE_EVENT_CONFIG,
} from '../src/balance.config.ts';
import { BLACKOUT_EVENT_WAVE } from '../src/gameConfig.ts';

test('grenade vs the Devil boss: exactly two direct explosions from full HP', () => {
  const { hp, explosiveDamageCap } = ENEMY_CONFIG.devil;
  assert.ok(explosiveDamageCap > 0, 'the boss needs a positive explosive damage cap');
  assert.ok(
    hp > explosiveDamageCap,
    `one explosion must NOT kill the Devil (cap ${explosiveDamageCap} < hp ${hp})`
  );
  assert.ok(
    hp <= 2 * explosiveDamageCap,
    `two explosions must kill the Devil (hp ${hp} <= ${2 * explosiveDamageCap})`
  );
  // the cap only ever reduces damage, so it must sit well below the raw blast
  assert.ok(
    GRENADE_CONFIG.damage > explosiveDamageCap,
    'raw grenade damage should exceed the boss cap'
  );
  // standard mobs keep the guaranteed one-hit kill even at the blast's edge
  const worstCase = GRENADE_CONFIG.damage * (1 - PHYSICS_CONFIG.explosionFalloff);
  assert.ok(worstCase > ENEMY_CONFIG.walker.hp, 'grenade must one-shot walkers at max falloff');
  assert.ok(worstCase > ENEMY_CONFIG.runner.hp, 'grenade must one-shot runners at max falloff');
});

test('mob drops are reduced by exactly 30% (a 0.70x multiplier)', () => {
  assert.equal(DROP_RATE_MULTIPLIER, 0.7, 'the drop-frequency knob is the 0.70x reduction');
  assert.equal(WAVE_CONFIG.dropRateMultiplier, DROP_RATE_MULTIPLIER);
  assert.ok(
    Math.abs(WAVE_CONFIG.mobDropRate - WAVE_CONFIG.baseDropRate * DROP_RATE_MULTIPLIER) < 1e-12,
    'effective drop rate must be baseDropRate × dropRateMultiplier'
  );
  assert.ok(
    Math.abs(WAVE_CONFIG.mobDropRate - WAVE_CONFIG.baseDropRate * 0.7) < 1e-12,
    'effective drop rate must be exactly 0.70× the base rate'
  );
  assert.ok(WAVE_CONFIG.mobDropRate < WAVE_CONFIG.baseDropRate, 'drops must be less frequent');
});

test('close-range shotgun blast still one-shots a standard walker', () => {
  const closeDamage = SHOTGUN_CONFIG.pelletCount * SHOTGUN_CONFIG.closeRangeDamage;
  assert.ok(SHOTGUN_CONFIG.closeRangeThreshold > 0, 'the close-range zone must exist');
  assert.ok(
    closeDamage > ENEMY_CONFIG.walker.hp,
    `${closeDamage} damage must exceed the walker's ${ENEMY_CONFIG.walker.hp} HP`
  );
});

test('grenade vs players: survives the first blast, dies on the second', () => {
  const damage = GRENADE_CONFIG.damageToPlayers;
  const maxHp = PLAYER_CONFIG.maxHp; // 100
  assert.equal(damage, 55, 'documented flat player damage is 55');
  assert.ok(maxHp - damage > 0, 'one blast must leave a full-HP player standing');
  assert.ok(maxHp - 2 * damage <= 0, 'two blasts must be lethal');
  // flat damage: no falloff, so the rule holds at any distance inside the radius
  assert.ok(GRENADE_CONFIG.explosionRadius > 0, 'the grenade needs a blast radius');
  assert.equal(GRENADE_CONFIG.damageToZombies, 9999, 'horde instakill damage');
  assert.equal(GRENADE_CONFIG.fuseTime, 0.6, 'fuse reduced to 0.6 s');
  assert.equal(GRENADE_CONFIG.throwVelocity, GRENADE_CONFIG.projectileSpeed,
    'throwVelocity names the arc speed the engine consumes');
});

test('grenade vs the Devil: two blasts destroy, one never does', () => {
  const { hp, explosiveDamageCap } = ENEMY_CONFIG.devil;
  assert.equal(GRENADE_CONFIG.damageToDevil, explosiveDamageCap,
    'damageToDevil must mirror the boss explosive armor cap');
  assert.ok(hp > GRENADE_CONFIG.damageToDevil, 'one blast must NOT kill the Devil');
  assert.ok(hp <= 2 * GRENADE_CONFIG.damageToDevil, 'two blasts must kill the Devil');
});

test('co-op revive loop: 10 s countdown, 2 s invulnerability', () => {
  assert.equal(COOP_CONFIG.reviveCountdown, 10, 'revive countdown is 10.0 s');
  assert.equal(COOP_CONFIG.reviveInvulnerability, 2, 'post-revive i-frames are 2.0 s');
  assert.ok(COOP_CONFIG.blinkInterval > 0 && COOP_CONFIG.blinkInterval <= 0.2,
    'downed mesh blinks about every 0.15 s');
  assert.ok(COOP_CONFIG.invulnBlinkInterval < COOP_CONFIG.blinkInterval,
    'revive flashing must be faster than the downed flashing');
  assert.ok(COOP_CONFIG.reviveCountdown > COOP_CONFIG.reviveInvulnerability);
});

test('active co-op revive: 1.8 u circle, 2.5 s continuous hold', () => {
  assert.equal(COOP_CONFIG.reviveCircleRadius, 1.8, 'glowing circle radius is 1.8 u');
  assert.equal(COOP_CONFIG.reviveHoldSeconds, 2.5, 'high-five hold is 2.5 s');
  assert.ok(
    COOP_CONFIG.reviveHoldSeconds < COOP_CONFIG.reviveCountdown,
    'the fast-track must beat the 10 s passive timer'
  );
  assert.ok(COOP_CONFIG.reviveCircleRadius > PLAYER_CONFIG.radius * 2,
    'the circle must fit a standing partner around the downed body');
});

test('wooden crates: 150 HP fortifications that never detonate', () => {
  assert.equal(CRATE_CONFIG.hp, 150, 'crates take 150 HP to claw down');
  assert.equal(CRATE_CONFIG.explodes, false, 'crates never explode — barrels do');
  assert.equal(CRATE_CONFIG.explosionRadius, 0, 'no blast radius at all');
  assert.equal(CRATE_CONFIG.kind, 'deployable');
  assert.equal(CRATE_CONFIG.hp, BARREL_CONFIG.damage,
    'the crate HP mirrors the barrel chew profile');
  assert.ok(CRATE_CONFIG.comboTier < BARREL_CONFIG.comboTier,
    'crates unlock before explosive barrels');
});

test('special wave events: speed horde at 4/12…, blackout at 6/14…', () => {
  assert.equal(WAVE_EVENT_CONFIG.period, 8);
  assert.equal(WAVE_EVENT_CONFIG.speedHordeOffset, 4);
  assert.equal(
    WAVE_EVENT_CONFIG.blackoutOffset,
    BLACKOUT_EVENT_WAVE % WAVE_EVENT_CONFIG.period,
    'the blackout wave is set by the darkness wave (gameConfig.ts)'
  );
  assert.equal(WAVE_EVENT_CONFIG.runnerSpeedBonus, 0.8, 'speed-horde runners move +80%');
  // widened so the guard still typechecks if the config values are edited equal
  const offsets: number[] = [WAVE_EVENT_CONFIG.speedHordeOffset, WAVE_EVENT_CONFIG.blackoutOffset];
  assert.ok(offsets[0] !== offsets[1], 'the two events must never collide on the same wave');
});

test('drop table: 0.70x frequency knob, uzi the most common weapon drop', () => {
  assert.equal(DROP_CONFIG.mobDropMultiplier, 0.7);
  assert.equal(DROP_RATE_MULTIPLIER, DROP_CONFIG.mobDropMultiplier);
  assert.equal(WAVE_CONFIG.dropRateMultiplier, DROP_CONFIG.mobDropMultiplier);
  assert.equal(WAVE_CONFIG.mobDropRate, DROP_CONFIG.effectiveDropRate);
  const weights = DROP_CONFIG.dropWeights;
  assert.equal(weights.uzi, UZI_CONFIG.dropRateWeight);
  assert.ok(weights.uzi > weights.shotgun && weights.uzi > weights.grenade,
    'uzi drops must out-weigh every other weapon');
  assert.ok(DROP_CONFIG.pickupAwards.uzi >= 150, 'uzi cubes award 150 rounds');
});

test('loot pickups credit score to the shared co-op pool', () => {
  assert.ok(DROP_CONFIG.pickupScore > 0, 'a pickup must be worth score');
  assert.ok(
    DROP_CONFIG.pickupScore >= ENEMY_CONFIG.walker.score,
    'a team pickup is worth at least a walker kill'
  );
  assert.equal(
    WAVE_CONFIG.pickupScore,
    DROP_CONFIG.pickupScore,
    'the wave table mirrors the drop table'
  );
});

test('weapon cadence & ammo rules (pistol −25%, rapid uzi, infinite pistol)', () => {
  // the pistol fired every 250 ms before; +33% delay == 25% slower cadence
  assert.ok(PISTOL_CONFIG.fireIntervalMs >= 1.33 * 250,
    `pistol interval ${PISTOL_CONFIG.fireIntervalMs} ms must be ~1.33× the old 250 ms`);
  assert.equal(PISTOL_CONFIG.infiniteAmmo, true);
  assert.equal(PISTOL_CONFIG.magSize, 0, 'magSize 0 = infinite ammo');
  // the uzi is tuned significantly faster than the pistol
  assert.ok(UZI_CONFIG.fireIntervalMs <= 60, 'uzi fires at a rapid cyclic rate');
  assert.ok(UZI_CONFIG.fireIntervalMs * 2 < PISTOL_CONFIG.fireIntervalMs);
  // shotgun: 5–6 pellets, close-range threshold of exactly 3 cells
  assert.ok(SHOTGUN_CONFIG.pelletCount >= 5 && SHOTGUN_CONFIG.pelletCount <= 6);
  assert.equal(SHOTGUN_CONFIG.closeRangeThreshold, 3);
  assert.ok(SHOTGUN_CONFIG.spread <= 0.1, 'shotgun spread cone is tight');
  // full HP restore on wave completion (Solo and Co-op)
  assert.equal(WAVE_CONFIG.fullHpRestoreOnWaveEnd, true);
});

test('shotgun pellet damage carries the cumulative +35% buff', () => {
  // base pellet: 10 → 13.5 (×1.35); close-range pellet keeps the same ratio
  assert.equal(SHOTGUN_CONFIG.damage, 13.5, 'pellet base damage is 10 × 1.35');
  assert.equal(SHOTGUN_CONFIG.closeRangeDamage, 20.25, 'close-range damage is 15 × 1.35');
  assert.equal(
    SHOTGUN_CONFIG.closeRangeDamage / SHOTGUN_CONFIG.damage,
    1.5,
    'proximity scaling (1.5× close/mid) is preserved'
  );
  // point blank still obliterates a dense cluster: a full close-range blast
  // clears a walker with margin to spare even if a pellet or two misses.
  assert.ok(
    SHOTGUN_CONFIG.pelletCount * SHOTGUN_CONFIG.closeRangeDamage > ENEMY_CONFIG.walker.hp * 1.5,
    'a point-blank blast must reliably one-shot a walker'
  );
  // the cone stays tight and the close-range zone is exactly 3 cells
  assert.ok(SHOTGUN_CONFIG.spread <= 0.1);
  assert.equal(SHOTGUN_CONFIG.closeRangeThreshold, 3);
});

test('barrel chain detonations use a 0.08 s staggered fuse', () => {
  assert.equal(BARREL_CONFIG.chainFuseDelay, 0.08, 'each chain link waits 0.08 s');
  assert.ok(
    BARREL_CONFIG.chainTriggerRadius > 0,
    'a blast needs reach to touch the next barrel'
  );
  assert.ok(
    BARREL_CONFIG.chainTriggerRadius <= BARREL_CONFIG.explosionRadius + 1,
    'the chain trigger mirrors the barrel AoE'
  );
});

test('end-of-wave enrage: 3 survivors at 1.75× speed', () => {
  assert.equal(DIRECTOR_CONFIG.enrageThreshold, 3, 'enrage at <= 3 remaining mobs');
  assert.equal(DIRECTOR_CONFIG.enrageSpeedMultiplier, 1.75, '+75% speed when enraged');
});

test('between-wave intermission is a 7–10 s grace period', () => {
  assert.equal(DIRECTOR_CONFIG.waveIntermissionMinSec, 7, 'the window opens at 7.0 s');
  assert.equal(DIRECTOR_CONFIG.waveIntermissionMaxSec, 10, 'the window closes at 10.0 s');
  assert.ok(
    DIRECTOR_CONFIG.waveIntermissionMinSec < DIRECTOR_CONFIG.waveIntermissionMaxSec,
    'the window must be a real range'
  );
  // the nominal value sits inside its own window (≈ the 8.5 s midpoint)
  assert.ok(
    DIRECTOR_CONFIG.waveIntermissionSec >= DIRECTOR_CONFIG.waveIntermissionMinSec &&
      DIRECTOR_CONFIG.waveIntermissionSec <= DIRECTOR_CONFIG.waveIntermissionMaxSec,
    'the nominal intermission must lie inside the randomised window'
  );
});

test('pickups despawn after 15 s with a 3 s flashing warning', () => {
  assert.equal(DROP_CONFIG.pickupLifeSeconds, 15);
  assert.equal(WAVE_CONFIG.pickupLifeSeconds, DROP_CONFIG.pickupLifeSeconds);
  assert.equal(DROP_CONFIG.pickupWarningSeconds, 3);
  assert.equal(WAVE_CONFIG.pickupWarningSeconds, DROP_CONFIG.pickupWarningSeconds);
  assert.ok(DROP_CONFIG.pickupBlinkInterval > 0, 'the warning must actually blink');
});

test('game feel: hit-stop, trauma shake and pooled voxel gibs', () => {
  assert.equal(JUICE_CONFIG.hitStopSeconds, 0.03, '30 ms micro-freeze on heavy hits');
  assert.equal(JUICE_CONFIG.shotgunTrauma, 0.08);
  assert.equal(JUICE_CONFIG.explosionTrauma, 0.2);
  assert.equal(JUICE_CONFIG.barrelChainTrauma, 0.35);
  assert.ok(JUICE_CONFIG.shotgunTrauma < JUICE_CONFIG.explosionTrauma);
  assert.ok(JUICE_CONFIG.explosionTrauma < JUICE_CONFIG.barrelChainTrauma);
  assert.equal(JUICE_CONFIG.gibCountMin, 4);
  assert.equal(JUICE_CONFIG.gibCountMax, 6);
  assert.equal(JUICE_CONFIG.gibLifeSeconds, 1.0);
  assert.ok(JUICE_CONFIG.gibCountBoss >= JUICE_CONFIG.gibCountMax);
  assert.ok(JUICE_CONFIG.gibPoolSize >= JUICE_CONFIG.gibCountBoss * 6, 'pool never starves');
});

test('spatial hash broadphase uses a positive bucket size', () => {
  assert.ok(SPATIAL_CONFIG.cellSize > 0);
  assert.ok(
    SPATIAL_CONFIG.cellSize >= ENEMY_CONFIG.devil.radius * 2,
    'a bucket spans at least the largest mob diameter'
  );
});

test('secret character LIZI: 150 HP, ×1.3 outgoing damage, default speed', () => {
  // The three documented knobs — tuned in balance.config.ts, consumed by the
  // client (player.ts hp/speed/damage, main.ts explosion scaling).
  assert.equal(LIZI_STATS.MAX_HP, 150, 'LIZI starts at 150 HP');
  assert.equal(LIZI_STATS.DAMAGE_MULTIPLIER, 1.3, 'weapon damage multiplier is 1.3');
  assert.equal(LIZI_STATS.SPEED_MULTIPLIER, 1.0, 'her speed matches the default (×1.0)');
  // She is deliberately tankier and hits harder than the base player.
  assert.ok(LIZI_STATS.MAX_HP > PLAYER_CONFIG.maxHp,
    `LIZI (${LIZI_STATS.MAX_HP}) must be tankier than the base ${PLAYER_CONFIG.maxHp} HP`);
  assert.ok(LIZI_STATS.DAMAGE_MULTIPLIER > 1, 'LIZI hits harder than the base multiplier');
  assert.ok(LIZI_STATS.SPEED_MULTIPLIER > 0, 'the speed multiplier is positive');
  // The extra weapon damage stacks on the base table: her pistol out-damages a
  // standard character's pistol while never becoming an instant-kill on bosses.
  const liziPistol = PISTOL_CONFIG.damage * LIZI_STATS.DAMAGE_MULTIPLIER;
  assert.ok(liziPistol > PISTOL_CONFIG.damage, 'her weapons hit harder than the base');
  assert.ok(liziPistol < ENEMY_CONFIG.devil.hp,
    'even a buffed pellet cannot one-shot the Devil');
  // Her hp pool still leaves the flat grenade blast survivable on the first hit.
  assert.ok(LIZI_STATS.MAX_HP - GRENADE_CONFIG.damageToPlayers > 0,
    'even LIZI survives the first grenade blast');
});

test('LIZI god-mode speed slider: 1.0–3.5 in 0.1 steps, default 1.0', () => {
  assert.equal(LIZI_SPEED_SLIDER.MIN, 1.0, 'the slider starts at normal speed');
  assert.equal(LIZI_SPEED_SLIDER.MAX, 3.5, 'the slider tops out at extreme sprint');
  assert.equal(LIZI_SPEED_SLIDER.STEP, 0.1, 'slider granularity is 0.1');
  assert.equal(LIZI_SPEED_SLIDER.DEFAULT, 1.0, 'the default multiplier is 1.0');
  assert.ok(LIZI_SPEED_SLIDER.MIN < LIZI_SPEED_SLIDER.MAX, 'the range is real');
  assert.ok(
    LIZI_SPEED_SLIDER.DEFAULT >= LIZI_SPEED_SLIDER.MIN &&
      LIZI_SPEED_SLIDER.DEFAULT <= LIZI_SPEED_SLIDER.MAX,
    'the default sits inside the range'
  );
  // min→max must be a whole number of steps, or the UI could never reach 3.5.
  const steps = (LIZI_SPEED_SLIDER.MAX - LIZI_SPEED_SLIDER.MIN) / LIZI_SPEED_SLIDER.STEP;
  assert.equal(steps, Math.round(steps), 'min→max is an exact whole number of steps');
});
