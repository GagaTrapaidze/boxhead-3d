import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DIRECTOR_CONFIG, ENEMY_CONFIG } from '../src/balance.config.ts';
import { WorldSim } from '../../server/src/rooms/world.ts';

const BLACK = ENEMY_CONFIG.blackDevil;
const DT = 1 / 30;

/** Builds a sim parked exactly on the Wave-7 intermission with one player. */
function simAtBossWave() {
  const sim = new WorldSim('classic-bunker');
  sim.syncPlayers([{ id: 'p1', x: 20.5, z: 20.5, alive: true }]);
  sim.wave = DIRECTOR_CONFIG.blackDevilWave - 1;
  sim.phase = 'intermission';
  sim.timer = 0.0001;
  sim.step(DT); // wave flips to 7, the boss queue is built
  assert.equal(sim.wave, DIRECTOR_CONFIG.blackDevilWave);
  // Let the whole (halved) queue disgorge; the boss leads the first batch.
  for (let i = 0; i < 600; i++) {
    if ((sim.phase as string) === 'active') break;
    sim.step(DT);
  }
  return sim;
}

test('wave 7 spawns the Black Devil first with the standard horde halved', () => {
  const sim = simAtBossWave();

  const boss = sim.enemies.find((enemy) => enemy.kind === 'blackDevil');
  assert.ok(boss, 'the Black Devil spawns on wave 7');
  assert.equal(boss.hp, BLACK.hp, 'the boss starts at full 1200 HP');
  assert.equal(boss.maxHp, BLACK.hp);

  // Exactly one boss, and no extra red Devils to split the players' attention.
  assert.equal(sim.enemies.filter((e) => e.kind === 'blackDevil').length, 1);
  assert.equal(sim.enemies.filter((e) => e.kind === 'devil').length, 0);

  // −50% small white mobs.
  const expectedMobs = Math.round(
    Math.min(
      DIRECTOR_CONFIG.maxCount,
      DIRECTOR_CONFIG.baseCount + DIRECTOR_CONFIG.perWaveCount * DIRECTOR_CONFIG.blackDevilWave
    ) * DIRECTOR_CONFIG.blackDevilMobCountMultiplier
  );
  const mobs = sim.enemies.filter((e) => e.kind === 'walker' || e.kind === 'runner').length;
  assert.equal(mobs, expectedMobs, `expected ${expectedMobs} small mobs, got ${mobs}`);
});

/**
 * Parks the Black Devil in the open with every other enemy cleared and the
 * laser / spinner isolated, so a single attack can be observed in isolation.
 */
function soloBoss(sim: WorldSim) {
  const boss = sim.enemies.find((e) => e.kind === 'blackDevil')!;
  for (const enemy of [...sim.enemies]) if (enemy !== boss) sim.damageEnemy(enemy.id, 1e9, 0, '');
  boss.x = 20.5;
  boss.z = 20.5;
  boss.speed = 0; // hold position so the geometry is deterministic
  boss.attackState = 'idle';
  boss.laserCooldown = 999;
  boss.fireCooldown = 999;
  boss.shockCooldown = 0;
  return boss;
}

test('black devil shockwave: the perimeter lands damage only when it reaches the body', () => {
  const sim = simAtBossWave();
  const boss = soloBoss(sim);
  // 2.0 u away: inside the 3 u shockwave trigger but outside melee reach.
  sim.syncPlayers([{ id: 'p1', x: 22.5, z: 20.5, alive: true }]);
  sim.drainEvents();
  sim.drainPlayerDamage();

  // One tick: the ring ripples out but has not reached the 1.5 u body, so a
  // plain "inside the radius" check must NOT have dealt any damage yet.
  sim.step(DT);
  assert.ok(
    sim.drainEvents().some((event) => event.type === 'shockwave'),
    'a player inside 3 u triggers an expanding shockwave'
  );
  assert.equal(
    sim.drainPlayerDamage().get('p1') ?? 0,
    0,
    'no damage on the first tick — the perimeter has not reached the body'
  );

  // Ride the ring out; it must land its flat damage as it sweeps past.
  let damage = 0;
  for (let i = 0; i < 30 && damage === 0; i++) {
    sim.step(DT);
    damage = sim.drainPlayerDamage().get('p1') ?? 0;
  }
  assert.equal(damage, BLACK.shockwaveDamage, 'the expanding perimeter deals the flat damage');

  // Strict cooldown: no second ring while the timer is still counting down.
  sim.drainEvents();
  boss.x = 20.0; // still crowded
  sim.step(DT);
  assert.ok(
    !sim.drainEvents().some((event) => event.type === 'shockwave'),
    'the 4.5 s cooldown blocks an immediate repeat'
  );
});

test('black devil shockwave is occluded by cover (a wooden crate absorbs it)', () => {
  const sim = simAtBossWave();
  const boss = soloBoss(sim);
  // A crate one cell in front of the player, on the boss→player ray.
  assert.ok(sim.placeProp('crate', 22, 20), 'a crate is placed between boss and player');
  sim.syncPlayers([{ id: 'p1', x: 23.4, z: 20.5, alive: true }]);
  sim.drainEvents();
  sim.drainPlayerDamage();

  let damage = 0;
  for (let i = 0; i < 60; i++) {
    sim.step(DT);
    damage += sim.drainPlayerDamage().get('p1') ?? 0;
  }
  assert.equal(sim.isCursed('p1'), false, 'cover also blocks the curse');
  assert.equal(damage, 0, 'the crate fully blocks the shockwave — no damage through cover');
});

test('black devil laser: the continuous raycast clamps the beam at cover mid-channel', () => {
  const sim = simAtBossWave();
  const boss = soloBoss(sim);
  boss.laserCooldown = 0; // allow the laser
  sim.syncPlayers([{ id: 'p1', x: 20.5, z: 26.5, alive: true }]);
  sim.step(DT);
  assert.equal(boss.attackState, 'charge', 'the laser locks on with a clear line of sight');

  for (let i = 0; i < Math.ceil(BLACK.laserTelegraph / DT) + 2; i++) sim.step(DT);
  assert.equal(boss.attackState, 'fire', 'the telegraph resolves into the beam');
  const clearReach = boss.laserLength;

  // Drop a crate between the boss and the target: the beam must now stop there.
  assert.ok(sim.placeProp('crate', 20, 25), 'a crate is placed on the beam path');
  sim.step(DT);
  assert.ok(
    boss.laserLength < clearReach,
    'the raycast clamp shortens the beam (from ' + clearReach + ' to ' + boss.laserLength + ')'
  );
  assert.ok(
    boss.laserLength <= 4.6,
    'the beam stops at the crate face (got ' + boss.laserLength + ')'
  );

  // And it cannot burn the player standing behind that crate.
  sim.drainPlayerDamage();
  let dealt = 0;
  for (let i = 0; i < 60; i++) {
    sim.step(DT);
    dealt += sim.drainPlayerDamage().get('p1') ?? 0;
  }
  assert.equal(dealt, 0, 'the laser cannot shoot through the crate');
});

test('shockwave curses its victim; a teammate holding the circle cleanses it', () => {
  const sim = simAtBossWave();
  const boss = soloBoss(sim);
  // p2 stands far outside the ring and the cleansing circle for now.
  sim.syncPlayers([
    { id: 'p1', x: 22.5, z: 20.5, alive: true },
    { id: 'p2', x: 30.5, z: 20.5, alive: true },
  ]);
  sim.drainEvents();
  sim.drainPlayerDamage();

  for (let i = 0; i < 30 && !sim.isCursed('p1'); i++) sim.step(DT);
  assert.ok(sim.isCursed('p1'), 'the struck player is cursed');
  assert.equal(sim.isCursed('p2'), false, 'a player outside the ring is untouched');
  assert.equal(
    sim.drainPlayerDamage().get('p1'),
    BLACK.shockwaveDamage,
    'the flat shockwave damage landed'
  );

  // Isolate the curse from any further rings.
  boss.shockCooldown = 9999;

  // One interval later: exactly one curse tick has bled off.
  for (let i = 0; i < Math.ceil(BLACK.curseTickInterval / DT) + 1; i++) sim.step(DT);
  assert.equal(
    sim.drainPlayerDamage().get('p1'),
    BLACK.curseDamage,
    'the curse deals its ticking damage'
  );
  assert.ok(sim.isCursed('p1'), 'the curse persists while no teammate is in the circle');

  // Move the teammate into the 2 u circle and hold a full 3 s cleanse.
  sim.syncPlayers([
    { id: 'p1', x: 22.5, z: 20.5, alive: true },
    { id: 'p2', x: 23.7, z: 20.5, alive: true },
  ]);
  const holdTicks = Math.ceil(BLACK.curseCleanseSeconds / DT) + 2;
  for (let i = 0; i < holdTicks; i++) sim.step(DT);
  assert.equal(sim.isCursed('p1'), false, 'a 3 s teammate hold lifts the curse');
});

test('solo runs: the shockwave deals impact damage but never applies the curse', () => {
  const sim = simAtBossWave();
  soloBoss(sim);
  sim.shockwaves.length = 0; // drop any ring already mid-flight from the wave start
  // A single player, inside the 3 u trigger and swept by the ring.
  sim.syncPlayers([{ id: 'p1', x: 22.5, z: 20.5, alive: true }]);
  sim.drainEvents();
  sim.drainPlayerDamage();

  let damage = 0;
  for (let i = 0; i < 60; i++) {
    sim.step(DT);
    damage += sim.drainPlayerDamage().get('p1') ?? 0;
  }
  assert.equal(damage, BLACK.shockwaveDamage, 'the solo shockwave still lands its flat damage');
  assert.equal(sim.isCursed('p1'), false, 'a single-player run never receives the curse');
});

test('a downed teammate opens a respawn window that blocks the curse for everyone', () => {
  const sim = simAtBossWave();
  soloBoss(sim);
  sim.shockwaves.length = 0;
  // p1 is up and in range; p2 is down on their respawn timer.
  sim.syncPlayers([
    { id: 'p1', x: 22.5, z: 20.5, alive: true },
    { id: 'p2', x: 30.5, z: 20.5, alive: false },
  ]);
  sim.drainEvents();
  sim.drainPlayerDamage();

  let damage = 0;
  for (let i = 0; i < 60; i++) {
    sim.step(DT);
    damage += sim.drainPlayerDamage().get('p1') ?? 0;
  }
  assert.equal(damage, BLACK.shockwaveDamage, 'the standing player still takes impact damage');
  assert.equal(sim.isCursed('p1'), false, 'nobody is cursed while a teammate is respawning');
  assert.equal(sim.isCursed('p2'), false, 'nor is the downed player cursed');
});

test('curse is exclusive: exactly one holder, whatever the shockwave sweeps', () => {
  const sim = simAtBossWave();
  const boss = soloBoss(sim);
  sim.shockwaves.length = 0;
  // Two live players, both inside the trigger and both swept by the same ring.
  sim.syncPlayers([
    { id: 'p1', x: 22.5, z: 20.5, alive: true },
    { id: 'p2', x: 18.5, z: 20.5, alive: true },
  ]);
  sim.drainEvents();
  sim.drainPlayerDamage();
  for (let i = 0; i < 60 && !sim.isCursed('p1') && !sim.isCursed('p2'); i++) sim.step(DT);

  const holders = ['p1', 'p2'].filter((id) => sim.isCursed(id));
  assert.equal(holders.length, 1, 'only one player may hold the curse at a time');

  // Down the holder: the curse lapses and the slot reopens — but only once the
  // respawn window closes (both players back on their feet).
  sim.syncPlayers([
    { id: 'p1', x: 22.5, z: 20.5, alive: holders[0] !== 'p1' },
    { id: 'p2', x: 18.5, z: 20.5, alive: holders[0] !== 'p2' },
  ]);
  boss.shockCooldown = 0;
  for (let i = 0; i < 40; i++) sim.step(DT);
  assert.equal(sim.isCursed(holders[0]), false, 'a downed holder loses the curse');
  assert.equal(
    ['p1', 'p2'].filter((id) => sim.isCursed(id)).length,
    0,
    'the respawn window keeps the surviving player immune'
  );

  // Both alive again: a fresh ring may curse someone once more.
  sim.syncPlayers([
    { id: 'p1', x: 22.5, z: 20.5, alive: true },
    { id: 'p2', x: 18.5, z: 20.5, alive: true },
  ]);
  sim.shockwaves.length = 0;
  boss.shockCooldown = 0;
  for (let i = 0; i < 60 && !sim.isCursed('p1') && !sim.isCursed('p2'); i++) sim.step(DT);
  assert.equal(
    ['p1', 'p2'].filter((id) => sim.isCursed(id)).length,
    1,
    'the freed slot accepts a new curse'
  );
});

test('black devil laser: telegraphs, then ticks damage during the beam', () => {
  const sim = simAtBossWave();
  const boss = sim.enemies.find((e) => e.kind === 'blackDevil')!;
  for (const enemy of [...sim.enemies]) if (enemy !== boss) sim.damageEnemy(enemy.id, 1e9, 0, '');

  boss.x = 20.5;
  boss.z = 20.5;
  boss.attackState = 'idle';
  boss.laserCooldown = 0;
  boss.shockCooldown = 999;
  boss.fireCooldown = 999;
  sim.syncPlayers([{ id: 'p1', x: 20.5 + 8, z: 20.5, alive: true }]);
  sim.drainEvents();
  sim.drainPlayerDamage();

  sim.step(DT);
  assert.equal(boss.attackState, 'charge', 'the laser begins with a telegraph');

  // Ride out the 1 s telegraph; the beam phase begins.
  for (let i = 0; i < Math.ceil(BLACK.laserTelegraph / DT) + 2; i++) sim.step(DT);
  assert.equal(boss.attackState, 'fire', 'the telegraph resolves into the beam');

  sim.drainPlayerDamage();
  for (let i = 0; i < Math.ceil(1 / DT); i++) sim.step(DT);
  const dealt = sim.drainPlayerDamage().get('p1') ?? 0;
  assert.ok(dealt >= BLACK.laserDamage, `the beam ticks damage (got ${dealt})`);
});

test('black devil spinner: fires a synchronized orbiting-cube projectile', () => {
  const sim = simAtBossWave();
  const boss = sim.enemies.find((e) => e.kind === 'blackDevil')!;
  for (const enemy of [...sim.enemies]) if (enemy !== boss) sim.damageEnemy(enemy.id, 1e9, 0, '');

  boss.x = 20.5;
  boss.z = 20.5;
  boss.attackState = 'idle';
  boss.laserCooldown = 999; // force the spinner branch
  boss.shockCooldown = 999;
  boss.fireCooldown = 0;
  sim.syncPlayers([{ id: 'p1', x: 20.5 + 7, z: 20.5, alive: true }]);

  sim.step(DT);
  const spinner = sim.fireballs.find((ball) => ball.kind === 'spinner');
  assert.ok(spinner, 'the boss fires a spinner at range');
  assert.ok(
    spinner!.life > BLACK.spinnerLife - 0.1,
    'the spinner launches with a full lifetime'
  );

  // The orbit phase must advance so the shared animation is synchronized.
  const spinBefore = spinner!.spin;
  sim.step(DT);
  assert.ok(spinner!.spin > spinBefore, 'the spinner orbit phase advances every tick');
});

test('black devil death pops a 3–4 reward loot explosion', () => {
  const sim = simAtBossWave();
  const boss = sim.enemies.find((e) => e.kind === 'blackDevil')!;
  for (const enemy of [...sim.enemies]) if (enemy !== boss) sim.damageEnemy(enemy.id, 1e9, 0, '');
  const before = sim.drops.length;

  sim.drainEvents();
  sim.damageEnemy(boss.id, 1e9, 0, 'p1');
  const killed = sim.drainEvents().find((event) => event.type === 'enemyKilled');
  assert.ok(killed && killed.type === 'enemyKilled' && killed.kind === 'blackDevil');

  const dropped = sim.drops.length - before;
  assert.ok(
    dropped >= BLACK.lootDropMin && dropped <= BLACK.lootDropMax,
    `expected ${BLACK.lootDropMin}–${BLACK.lootDropMax} rewards, got ${dropped}`
  );
});
