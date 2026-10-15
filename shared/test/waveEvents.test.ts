import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENEMY_CONFIG, WAVE_EVENT_CONFIG } from '../src/balance.config.ts';
import { BLACKOUT_EVENT_WAVE } from '../src/gameConfig.ts';
import { waveEventFor, waveEventLabel } from '../src/waveEvents.ts';

const { period, speedHordeOffset, blackoutOffset } = WAVE_EVENT_CONFIG;

/** Blackout waves from the configured first wave up to `max`. */
function blackoutWaves(max: number): number[] {
  const waves: number[] = [];
  for (let wave = BLACKOUT_EVENT_WAVE; wave <= max; wave += period) waves.push(wave);
  return waves;
}

test('standard waves host no event', () => {
  // Every wave that hosts neither offset is a standard wave.
  for (let wave = 1; wave <= 32; wave++) {
    if (wave % period === speedHordeOffset || wave % period === blackoutOffset) continue;
    assert.equal(waveEventFor(wave), 'none', `wave ${wave} is standard`);
  }
  assert.equal(waveEventFor(0), 'none', 'wave 0 is pre-game');
  assert.equal(waveEventFor(-4), 'none', 'negative waves are nonsense');
  assert.equal(waveEventFor(4.5), 'none', 'non-integer waves are nonsense');
});

test('speed-horde waves: 4, 12, 20 … — runners only at +80% speed, 40 HP', () => {
  for (const wave of [4, 12, 20, 28]) {
    assert.equal(waveEventFor(wave), 'speedHorde', `wave ${wave} is a speed horde`);
  }
  assert.equal(WAVE_EVENT_CONFIG.runnerSpeedBonus, 0.8, 'runners move +80% faster');
  const boosted = ENEMY_CONFIG.runner.speed * (1 + WAVE_EVENT_CONFIG.runnerSpeedBonus);
  assert.equal(boosted, 6.48, '3.6 u/s × 1.8 = 6.48 u/s');
  assert.ok(boosted > ENEMY_CONFIG.runner.speed);
  assert.equal(ENEMY_CONFIG.runner.hp, 40, 'speed-horde runners keep their lightweight 40 HP');
});

test('blackout waves start at BLACKOUT_EVENT_WAVE and repeat every `period`', () => {
  const waves = blackoutWaves(32);
  assert.equal(waves[0], BLACKOUT_EVENT_WAVE, 'the first blackout is the configured wave');
  for (const wave of waves) {
    assert.equal(waveEventFor(wave), 'blackout', `wave ${wave} is a blackout`);
  }
  assert.ok(waveEventFor(BLACKOUT_EVENT_WAVE - 1) !== 'blackout', 'none before the first');
});

test('speed horde and blackout events never collide on the same wave', () => {
  assert.notEqual(speedHordeOffset, blackoutOffset, 'the two events must use different offsets');
  const eventWaves: number[] = [];
  for (let wave = 1; wave <= 32; wave++) {
    if (waveEventFor(wave) !== 'none') eventWaves.push(wave);
  }
  for (const wave of eventWaves) {
    const isSpeed = wave % period === speedHordeOffset;
    const isBlackout = wave % period === blackoutOffset;
    assert.ok(isSpeed !== isBlackout, `wave ${wave} hosts exactly one event`);
  }
  for (const wave of [4, 12, 20, 28]) {
    assert.ok(eventWaves.includes(wave), `wave ${wave} hosts the speed horde`);
  }
});

test('event labels drive the HUD banner', () => {
  assert.equal(waveEventLabel('speedHorde'), 'SPEED HORDE!');
  assert.equal(waveEventLabel('blackout'), 'BLACKOUT!');
  assert.equal(waveEventLabel('none'), null);
});
