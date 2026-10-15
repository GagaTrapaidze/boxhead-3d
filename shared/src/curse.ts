/**
 * Black Devil "Curse" runtime — the co-op debuff applied when a shockwave lands
 * on a player.
 *
 * A cursed player bleeds ticking damage until a *teammate* stands inside the
 * cleansing circle (centred on the cursed body) continuously for
 * `curseCleanseSeconds`. The same pure helpers run on the server authority and
 * on the offline client AI, so the tick cadence and cleanse countdown agree
 * everywhere; only the transport (Colyseus schema vs. local state) differs.
 */
import { ENEMY_CONFIG } from './balance.config.ts';

const CURSE = ENEMY_CONFIG.blackDevil;

/** Mutable per-player curse state (tick clock + cleanse hold). */
export interface CurseState {
  /** Countdown to the next curse damage tick, in seconds. */
  tickTimer: number;
  /** Continuous seconds a teammate has held inside the cleansing circle. */
  cleanseTimer: number;
}

/** A fresh curse: its first damage tick lands after one full interval. */
export function createCurseState(): CurseState {
  return { tickTimer: CURSE.curseTickInterval, cleanseTimer: 0 };
}

/** Result of one `advanceCurse` step. */
export interface CurseStep {
  /** Damage to apply this step (0 when no tick elapsed). */
  damage: number;
  /** True the instant the 3 s teammate hold completes (`cleanseTimer` full). */
  cleansed: boolean;
}

/**
 * Advances one cursed player by `dt`.
 *
 * `cleansed` is whether a teammate is currently inside the circle: while true
 * the hold accumulates, the moment it drops the hold resets (the requirement is
 * a *continuous* 3 s). Damage ticks on a fixed interval and can never be skipped
 * by a large `dt` (the loop catches up).
 */
export function advanceCurse(state: CurseState, dt: number, cleansed: boolean): CurseStep {
  let damage = 0;
  const interval = CURSE.curseTickInterval;
  if (interval > 0) {
    state.tickTimer -= dt;
    let guard = 0;
    while (state.tickTimer <= 0 && guard++ < 64) {
      state.tickTimer += interval;
      damage += CURSE.curseDamage;
    }
  }

  if (cleansed) {
    state.cleanseTimer = Math.min(CURSE.curseCleanseSeconds, state.cleanseTimer + dt);
  } else {
    state.cleanseTimer = 0; // the hold must be continuous
  }

  return { damage, cleansed: state.cleanseTimer >= CURSE.curseCleanseSeconds };
}

/** Normalized cleanse progress (0..1) for the UI's radial indicator. */
export function curseProgress(state: CurseState): number {
  if (CURSE.curseCleanseSeconds <= 0) return 0;
  return Math.min(1, state.cleanseTimer / CURSE.curseCleanseSeconds);
}

/** Seconds still needed to finish cleansing (for the HUD countdown). */
export function curseRemainingSeconds(state: CurseState): number {
  return Math.max(0, CURSE.curseCleanseSeconds - state.cleanseTimer);
}

/** True when `helper` is standing inside the cleansing circle around `cursed`. */
export function isInCurseCircle(
  cursedX: number,
  cursedZ: number,
  helperX: number,
  helperZ: number
): boolean {
  return Math.hypot(helperX - cursedX, helperZ - cursedZ) <= CURSE.curseRadius;
}

/**
 * Everything the strict curse guards need to decide whether a shockwave may
 * inflict the debuff. Kept transport-agnostic (plain strings/counts) so the
 * server authority and the offline client AI evaluate the exact same rules.
 */
export interface CurseGuardInput {
  /** Players in the match. Solo — fewer than two players — disables the curse. */
  playerCount: number;
  /** The single player currently holding the curse ('' when nobody is cursed). */
  activeCursedId: string;
  /** The player the shockwave's perimeter just swept. */
  targetId: string;
  /** The target is alive and outside the respawn / revive window. */
  targetAlive: boolean;
  /** Any player is down (on the respawn timer or being actively revived). */
  anyPlayerDowned: boolean;
}

/**
 * The three strict guard conditions, evaluated *before* the curse is applied.
 *
 * 1. Solo immunity — with fewer than two players the curse is disabled
 *    entirely (the shockwave still deals its flat impact damage).
 * 2. One active curse at a time — while another player holds the curse, nobody
 *    else may be cursed until that player is cleansed or dies.
 * 3. Respawn / revive immunity window — if *any* player is down (waiting on the
 *    recovery timer or being actively revived) nobody may receive the curse.
 */
export function canApplyCurse(input: CurseGuardInput): boolean {
  // 1. Solo mode: single-player runs never carry the curse.
  if (input.playerCount < 2) return false;
  // 3. Respawn / revive window: one downed teammate makes the whole match
  //    curse-immune for the duration.
  if (input.anyPlayerDowned) return false;
  // Never curse a body that is itself down / mid-revive.
  if (!input.targetAlive) return false;
  // 2. Only one curse may live at a time (re-applying to the same holder keeps
  //    its existing clocks and is handled by the caller).
  if (input.activeCursedId !== '' && input.activeCursedId !== input.targetId) return false;
  return true;
}

/** The cleansing-circle radius (world units / platform blocks). */
export const CURSE_RADIUS = CURSE.curseRadius;
/** Seconds a teammate must hold to cleanse. */
export const CURSE_CLEANSE_SECONDS = CURSE.curseCleanseSeconds;
/** HP lost per curse tick. */
export const CURSE_DAMAGE = CURSE.curseDamage;
/** Seconds between curse ticks. */
export const CURSE_TICK_INTERVAL = CURSE.curseTickInterval;
