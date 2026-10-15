import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLACK_DEVIL_START_WAVE,
  DARKNESS_START_WAVE,
  GAME_CONFIG,
  darknessActive,
} from '../src/gameConfig.ts';
import {
  BLACK_DEVIL_MIN_WAVE,
  DIRECTOR_CONFIG,
  SHOCKWAVE_EXPANSION_SPEED,
} from '../src/balance.config.ts';
import { waveEventFor } from '../src/waveEvents.ts';

test('GAME_CONFIG exposes the shared cross-mode values', () => {
  assert.equal(GAME_CONFIG.DARKNESS_START_WAVE, 6, 'darkness starts at wave 6');
  assert.equal(GAME_CONFIG.BLACK_DEVIL_START_WAVE, 7, 'the Black Devil spawns at wave 7');
  assert.equal(GAME_CONFIG.SHOCKWAVE_EXPANSION_SPEED, 8, 'the shockwave expands at 8 u/s');
  assert.equal(DARKNESS_START_WAVE, GAME_CONFIG.DARKNESS_START_WAVE, 'the re-export matches');
  assert.equal(BLACK_DEVIL_START_WAVE, GAME_CONFIG.BLACK_DEVIL_START_WAVE, 'the re-export matches');
});

test('balance.config derives the boss encounter and the shockwave from GAME_CONFIG', () => {
  assert.equal(
    DIRECTOR_CONFIG.blackDevilWave,
    GAME_CONFIG.BLACK_DEVIL_START_WAVE,
    'the director boss wave mirrors the shared config'
  );
  assert.equal(
    BLACK_DEVIL_MIN_WAVE,
    GAME_CONFIG.BLACK_DEVIL_START_WAVE,
    'the hard boss-wave floor mirrors the shared config'
  );
  assert.equal(
    SHOCKWAVE_EXPANSION_SPEED,
    GAME_CONFIG.SHOCKWAVE_EXPANSION_SPEED,
    'the shockwave speed is the single shared knob'
  );
});

test('the darkness wave is a persistent state, not a themed event wave', () => {
  // Darkness is a lighting state that begins at wave 6 and stays on; it must not
  // collide with the periodic speed-horde / blackout event waves.
  assert.equal(waveEventFor(GAME_CONFIG.DARKNESS_START_WAVE), 'none');
  assert.ok(
    GAME_CONFIG.DARKNESS_START_WAVE < GAME_CONFIG.BLACK_DEVIL_START_WAVE,
    'darkness falls before the boss encounter so the fight is played in the dark'
  );
});

test('darknessActive: night falls at DARKNESS_START_WAVE and never before', () => {
  const start = GAME_CONFIG.DARKNESS_START_WAVE;
  assert.equal(darknessActive(start - 1), false, 'the wave before is still daylight');
  assert.equal(darknessActive(start), true, 'the darkness wave turns the lights off');
  assert.equal(darknessActive(start + 5), true, 'and it stays dark on later waves');
  assert.equal(darknessActive(1), false, 'the opening waves are bright');
  assert.equal(darknessActive(0), false, 'pre-game is bright');
  assert.equal(darknessActive(start, true), true, 'a blackout event is always dark');
  assert.equal(darknessActive(1, true), true, 'the blackout event darkens an early wave too');
  assert.equal(darknessActive(3.5), false, 'non-integer waves never engage the rig');
});
