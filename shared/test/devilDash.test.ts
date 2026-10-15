import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENEMY_CONFIG } from '../src/balance.config.ts';
import { wrapAngle } from '../src/steering.ts';
import { WorldSim } from '../../server/src/rooms/world.ts';
import type { SimEnemy } from '../../server/src/rooms/world.ts';

const DT = 1 / 30;
const DEVIL = ENEMY_CONFIG.devil;

test('phase-2 dash tuning: a 3–4 s homing pursuit', () => {
  assert.ok(ENEMY_CONFIG.devilDashTurnRate > 0, 'the charge steers (homes) toward its target');
  assert.ok(
    ENEMY_CONFIG.devilDashDuration >= 3 && ENEMY_CONFIG.devilDashDuration <= 4,
    'the pursuit lasts 3–4 seconds'
  );
  assert.ok(
    ENEMY_CONFIG.devilDashTurnRate * ENEMY_CONFIG.devilDashDuration >= Math.PI,
    'the turn budget lets the Devil reverse within a single charge'
  );
  assert.ok(ENEMY_CONFIG.devilDashSpeedMultiplier > 1, 'the dash is faster than a normal chase');
});

/** A fresh sim with the wave director frozen so it spawns nothing on its own. */
function frozenSim(playerX: number, playerZ: number): WorldSim {
  const sim = new WorldSim('classic-bunker');
  sim.syncPlayers([{ id: 'p1', x: playerX, z: playerZ, alive: true }]);
  sim.wave = 0;
  sim.phase = 'intermission';
  sim.timer = 1e9; // never starts a wave
  return sim;
}

/** A phase-2 Red Devil mid-charge, parked in the open arena. */
function dashingDevil(
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  hazTimer = 1e9
): SimEnemy {
  return {
    id: 999,
    kind: 'devil',
    hp: DEVIL.hp,
    maxHp: DEVIL.hp,
    x,
    z,
    dir: 0,
    radius: DEVIL.radius,
    speed: DEVIL.speed,
    damage: DEVIL.damage,
    score: DEVIL.score,
    attackCooldown: 0,
    wallTimer: 0,
    fireCooldown: 0,
    suppressTimer: 0,
    enraged: false,
    phase2: true,
    dashState: 'dash',
    dashTimer: ENEMY_CONFIG.devilDashDuration,
    dashDirX: dirX,
    dashDirZ: dirZ,
    hazTimer,
    attackState: 'idle',
    attackTimer: 0,
    laserCooldown: 0,
    laserDirX: 0,
    laserDirZ: 0,
    laserTarget: '',
    laserTick: 0,
    laserLength: 0,
    shockCooldown: 0,
    target: '',
  };
}

test('a charging Devil homes onto the target instead of flying a frozen line', () => {
  // Target straight along +z; the Devil commits its charge along +x (perpendicular
  // to the target), exactly the case the old locked-vector dash flew past.
  const sim = frozenSim(20.5, 28.5);
  const devil = dashingDevil(20.5, 20.5, 1, 0, 0);
  sim.enemies.push(devil);

  const desired = 0; // atan2(0, +8) → +z
  const errorBefore = Math.abs(wrapAngle(Math.atan2(devil.dashDirX, devil.dashDirZ) - desired));
  assert.ok(errorBefore > 1.4, 'the charge starts nearly perpendicular to the target');

  for (let i = 0; i < 10; i++) sim.step(DT);

  const heading = Math.atan2(devil.dashDirX, devil.dashDirZ);
  const errorAfter = Math.abs(wrapAngle(heading - desired));
  assert.ok(errorAfter < errorBefore, `the heading turned toward the target (${errorBefore} → ${errorAfter})`);
  assert.ok(devil.dashDirZ > 0.4, 'the charge has curved toward +z, where the player is');
  assert.ok(devil.dashDirX < 0.95, 'it is no longer flying straight along its original +x heading');
  // The curved path is real: it gained ground in z, which a frozen +x line never would.
  assert.ok(devil.z > 20.5 + 0.2, `the charge curved off the frozen line (z ${devil.z})`);

  // The fire trail follows the actual path (dropped at the Devil's live position).
  assert.ok(sim.hazards.length >= 2, 'the fire trail keeps dropping while charging');
  assert.ok(
    sim.hazards.some((hazard) => hazard.z > 20.5 + 0.1),
    'the trail bends with the charge rather than forming a straight line'
  );

  // It keeps homing: the remaining heading error shrinks over more ticks.
  for (let i = 0; i < 6; i++) sim.step(DT);
  const laterError = Math.abs(wrapAngle(Math.atan2(devil.dashDirX, devil.dashDirZ) - desired));
  assert.ok(laterError < errorAfter, 'the heading keeps closing on the live target');
});

test('the charge ends after its duration and enters the cooldown', () => {
  const sim = frozenSim(20.5, 40); // far away: no melee contact
  const devil = dashingDevil(20.5, 20.5, 0, 1);
  devil.dashTimer = 0.01;
  sim.enemies.push(devil);

  sim.step(DT);

  assert.equal(devil.dashState, 'idle', 'the dash state ends when the timer lapses');
  assert.ok(
    Math.abs(devil.dashTimer - ENEMY_CONFIG.devilDashInterval) < 1e-6,
    'it enters the full dash cooldown'
  );
  assert.equal(sim.drainPlayerDamage().get('p1') ?? 0, 0, 'no impact happened, so no melee damage');
});

test('the charge ends the instant it lands a melee hit', () => {
  const sim = frozenSim(21.7, 20.5); // ~1.2 u away, inside melee reach after separation
  const devil = dashingDevil(20.5, 20.5, 1, 0); // charging straight at the player
  sim.enemies.push(devil);

  sim.step(DT);

  assert.ok(
    (sim.drainPlayerDamage().get('p1') ?? 0) >= DEVIL.damage,
    'the charge lands its melee damage'
  );
  assert.equal(devil.dashState, 'idle', 'the rush terminates on the impact');
  assert.ok(
    Math.abs(devil.dashTimer - ENEMY_CONFIG.devilDashInterval) < 1e-6,
    'and it falls back to the cooldown / normal chase speed'
  );
});
