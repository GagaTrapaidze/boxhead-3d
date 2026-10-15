import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLACK_DEVIL_START_WAVE,
  BLACKOUT_EVENT_WAVE,
  DARKNESS_START_WAVE,
  GAME_CONFIG,
} from '../src/gameConfig.ts';
import {
  BLACK_DEVIL_MIN_WAVE,
  DIRECTOR_CONFIG,
  SHOCKWAVE_EXPANSION_SPEED,
  WAVE_EVENT_CONFIG,
} from '../src/balance.config.ts';
import { darknessActive, waveEventFor } from '../src/waveEvents.ts';

test('GAME_CONFIG exposes the shared cross-mode values', () => {
  assert.equal(GAME_CONFIG.DARKNESS_START_WAVE, 6, 'darkness starts at wave 6');
  assert.equal(GAME_CONFIG.BLACK_DEVIL_START_WAVE, 7, 'the Black Devil spawns at wave 7');
  assert.equal(GAME_CONFIG.SHOCKWAVE_EXPANSION_SPEED, 8, 'the shockwave expands at 8 u/s');
  assert.equal(DARKNESS_START_WAVE, GAME_CONFIG.DARKNESS_START_WAVE, 'the re-export matches');
  assert.equal(BLACK_DEVIL_START_WAVE, GAME_CONFIG.BLACK_DEVIL_START_WAVE, 'the re-export matches');
});

test('the blackout event wave derives from the single darkness knob', () => {
  assert.equal(
    BLACKOUT_EVENT_WAVE,
    DARKNESS_START_WAVE,
    'darkness and the blackout event are the same wave — one number moves both'
  );
  assert.equal(
    WAVE_EVENT_CONFIG.blackoutOffset,
    BLACKOUT_EVENT_WAVE % WAVE_EVENT_CONFIG.period,
    'the blackout cadence derives from the darkness wave'
  );
});

test('balance.config derives the boss floor and the shockwave from GAME_CONFIG', () => {
  assert.equal(
    BLACK_DEVIL_MIN_WAVE,
    GAME_CONFIG.BLACK_DEVIL_START_WAVE,
    'the hard boss-wave floor mirrors the shared config'
  );
  assert.ok(
    DIRECTOR_CONFIG.blackDevilWave >= BLACK_DEVIL_MIN_WAVE,
    'the tunable boss wave (balance.config.ts) is never below the shared floor'
  );
  assert.equal(
    SHOCKWAVE_EXPANSION_SPEED,
    GAME_CONFIG.SHOCKWAVE_EXPANSION_SPEED,
    'the shockwave speed is the single shared knob'
  );
});

test('darkness is the periodic blackout event, never a permanent band', () => {
  const start = DARKNESS_START_WAVE;
  const period = WAVE_EVENT_CONFIG.period;
  assert.equal(waveEventFor(start), 'blackout', 'the first dark wave hosts the blackout event');
  assert.equal(darknessActive(start), true, 'darkness falls on the configured wave');
  assert.equal(darknessActive(start - 1), false, 'the wave before is still daylight');
  assert.equal(darknessActive(start + 1), false, 'it does NOT stay on the following wave');
  assert.equal(darknessActive(start + period - 1), false, 'nor on the rest of the cycle');
  assert.equal(darknessActive(start + period), true, 'and it returns exactly one period later');
  assert.equal(waveEventFor(start + period), 'blackout', 'the recurring dark wave is a blackout too');
  assert.equal(darknessActive(1), false, 'the opening waves are bright');
  assert.equal(darknessActive(0), false, 'pre-game is bright');
  assert.equal(darknessActive(3.5), false, 'non-integer waves never engage the rig');
  assert.equal(darknessActive(start - 1, true), true, 'an explicit blackout flag still forces the dark');
});

test('the dark waves are exactly the blackout cadence (6, 14, 22 … by default)', () => {
  const darkWaves: number[] = [];
  for (let wave = 1; wave <= 40; wave++) if (darknessActive(wave)) darkWaves.push(wave);
  assert.deepEqual(darkWaves, [6, 14, 22, 30, 38]);
  assert.equal(darknessActive(DARKNESS_START_WAVE - 1), false, 'nothing dark before the first wave');
});
