// ---------------------------------------------------------------------------
// Co-op revive rules — shared so client (and later server) agree.
//
// Two paths revive a downed player:
//  - Passive: the 10-second countdown always runs — ignore your partner and
//    they revive anyway after `reviveCountdown`.
//  - Active "high-five": a living partner standing inside the glowing circle
//    (radius `reviveCircleRadius`) accumulates `reviveHoldSeconds` of
//    CONTINUOUS hold and revives the downed player immediately. Stepping out
//    of the circle resets the hold to zero — but never the passive timer.
//
// Both paths reset the revived player to the starter Pistol with
// `reviveInvulnerability` seconds of i-frames (enforced by the caller).
// ---------------------------------------------------------------------------

import { COOP_CONFIG } from './balance.config.ts';

export interface ReviveState {
  /** Seconds left on the passive countdown (starts at `reviveCountdown`). */
  timer: number;
  /** Continuous seconds the partner has stood inside the revive circle. */
  hold: number;
}

/** Fresh downed-state timers. */
export function createReviveState(): ReviveState {
  return { timer: COOP_CONFIG.reviveCountdown, hold: 0 };
}

/** 'waiting' | revived by the active circle hold | revived by the 10 s timer. */
export type ReviveOutcome = 'waiting' | 'active' | 'passive';

/**
 * One tick of the downed/revive loop.
 *
 * - The passive countdown ALWAYS runs; hitting zero revives (outcome 'passive').
 * - `partnerInCircle` accumulates the hold; reaching `reviveHoldSeconds`
 *   revives instantly (outcome 'active') — the fastest possible revive.
 * - With the partner out of the circle the hold resets to zero, so the fast
 *   track demands a *continuous* 2.5 s stand.
 */
export function advanceRevive(
  state: ReviveState,
  partnerInCircle: boolean,
  dt: number
): ReviveOutcome {
  state.timer -= dt;
  if (partnerInCircle) {
    state.hold += dt;
    if (state.hold >= COOP_CONFIG.reviveHoldSeconds) return 'active';
  } else {
    state.hold = 0; // continuous hold only — leaving the circle restarts it
  }
  if (state.timer <= 0) return 'passive';
  return 'waiting';
}

/** Whether a partner's position stands inside the downed player's circle. */
export function isInReviveCircle(
  downedX: number,
  downedZ: number,
  partnerX: number,
  partnerZ: number,
  radius: number = COOP_CONFIG.reviveCircleRadius
): boolean {
  return Math.hypot(partnerX - downedX, partnerZ - downedZ) <= radius;
}
