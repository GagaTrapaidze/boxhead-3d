import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COOP_CONFIG } from '../src/balance.config.ts';
import { advanceRevive, createReviveState, isInReviveCircle } from '../src/revive.ts';

test('passive revive: the 10 s countdown revives an ignored partner', () => {
  const state = createReviveState();
  assert.equal(state.timer, COOP_CONFIG.reviveCountdown, 'starts at 10 s');
  assert.equal(state.hold, 0);

  // 0.25 s ticks are exact in binary float, so the countdown is deterministic:
  // 39 ticks = 9.75 s → still waiting, hold never moves.
  for (let i = 0; i < 39; i++) {
    assert.equal(advanceRevive(state, false, 0.25), 'waiting', `tick ${i}`);
    assert.equal(state.hold, 0, 'no partner in the circle, no hold');
  }
  assert.equal(state.timer, 0.25, 'exactly a quarter second remains');
  // the final tick lapses the 10 s timer → passive revive
  assert.equal(advanceRevive(state, false, 0.25), 'passive');
});

test('active revive: 2.5 s of continuous hold fast-tracks the revive', () => {
  const state = createReviveState();
  assert.equal(advanceRevive(state, true, 1.0), 'waiting');
  assert.equal(advanceRevive(state, true, 1.0), 'waiting');
  assert.equal(state.hold, 2.0);
  assert.ok(state.timer > 7, 'the passive timer still has most of its 10 s left');
  assert.equal(advanceRevive(state, true, 0.5), 'active', '2.5 s held → instant revive');
});

test('leaving the circle resets the hold but never the passive timer', () => {
  const state = createReviveState();
  advanceRevive(state, true, 2.0); // 2.0 s held…
  advanceRevive(state, false, 2.0); // …partner stepped out
  assert.equal(state.hold, 0, 'hold resets on exit — it must be continuous');
  assert.ok(Math.abs(state.timer - 6) < 1e-9, 'passive countdown kept running');

  // re-entering starts a fresh 2.5 s hold from zero
  assert.equal(advanceRevive(state, true, 2.4), 'waiting');
  assert.equal(advanceRevive(state, true, 0.1), 'active');
});

test('the passive timer can beat an interrupted hold', () => {
  const state = createReviveState();
  state.timer = 1.0; // nearly lapsed
  assert.equal(advanceRevive(state, true, 0.5), 'waiting'); // hold at 0.5
  advanceRevive(state, false, 0.5); // partner bails — hold resets, timer lapses
  assert.equal(state.hold, 0);
  assert.equal(advanceRevive(state, false, 0.1), 'passive',
    'the 10 s countdown still revives the partnerless downed player');
});

test('the revive circle covers a partner standing within 1.8 units', () => {
  assert.equal(COOP_CONFIG.reviveCircleRadius, 1.8);
  assert.equal(isInReviveCircle(10, 10, 11.79, 10), true, 'inside the ring');
  assert.equal(isInReviveCircle(10, 10, 11.81, 10), false, 'outside the ring');
  assert.equal(isInReviveCircle(10, 10, 10, 10), true, 'standing on the downed ally counts');
  // diagonal reach is also 1.8 (a circle, not a square)
  const d = 1.8 / Math.SQRT2;
  assert.equal(isInReviveCircle(0, 0, d, d), true, 'diagonal edge is inside');
  assert.equal(isInReviveCircle(0, 0, d * 1.1, d * 1.1), false, 'diagonal corner is outside');
});
