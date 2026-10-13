import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ENEMY_CONFIG, WAVE_EVENT_CONFIG } from '../src/balance.config.ts';
import { waveEventFor, waveEventLabel } from '../src/waveEvents.ts';

test('standard waves host no event', () => {
  for (const wave of [1, 2, 3, 5, 6, 7, 9, 10, 11]) {
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

test('blackout waves: 8, 16, 24 … — lights-out between events', () => {
  for (const wave of [8, 16, 24, 32]) {
    assert.equal(waveEventFor(wave), 'blackout', `wave ${wave} is a blackout`);
  }
});

test('events interleave every 4 waves and never repeat back-to-back', () => {
  const eventWaves: number[] = [];
  for (let wave = 1; wave <= 32; wave++) {
    if (waveEventFor(wave) !== 'none') eventWaves.push(wave);
  }
  assert.deepEqual(eventWaves, [4, 8, 12, 16, 20, 24, 28, 32]);
  // alternate: speed → blackout → speed → blackout …
  assert.equal(waveEventFor(4), 'speedHorde');
  assert.equal(waveEventFor(8), 'blackout');
  assert.equal(waveEventFor(12), 'speedHorde');
  assert.equal(waveEventFor(16), 'blackout');
});

test('event labels drive the HUD banner', () => {
  assert.equal(waveEventLabel('speedHorde'), 'SPEED HORDE!');
  assert.equal(waveEventLabel('blackout'), 'BLACKOUT!');
  assert.equal(waveEventLabel('none'), null);
});
