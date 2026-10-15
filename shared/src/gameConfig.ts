/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  GLOBAL GAME CONFIGURATION — one shared source of truth for Solo, local
 *  co-op and online multiplayer (client AND server).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * These are the few values that must agree everywhere because they change what
 * every mode renders or simulates. They live here — not scattered across the
 * engine — so editing one number changes Solo, local co-op and online at once:
 *
 *  - `DARKNESS_START_WAVE` — from this wave onward the arena stays dark and
 *    every player carries a flashlight. The client lighting rig reads it each
 *    frame, so the night falls at the same wave in every mode.
 *  - `BLACK_DEVIL_START_WAVE` — the wave that hosts the Black Devil encounter.
 *    `DIRECTOR_CONFIG.blackDevilWave` and the hard `BLACK_DEVIL_MIN_WAVE` floor
 *    both derive from it, on the client director and the server world alike.
 *  - `SHOCKWAVE_EXPANSION_SPEED` — world units/second the boss shockwave ring
 *    expands at (the server authority and the offline client AI share it).
 *
 * `balance.config.ts` imports and re-exports these so gameplay tuning stays
 * centralized there while these mode-spanning values live in exactly one file.
 */
export const GAME_CONFIG = {
  /** Wave where the darkness / night lighting triggers (and stays on). */
  DARKNESS_START_WAVE: 6,
  /** Wave where the Black Devil boss spawns. */
  BLACK_DEVIL_START_WAVE: 7,
  /** Expansion speed of the Black Devil's shockwave ring (world units/second). */
  SHOCKWAVE_EXPANSION_SPEED: 8,
} as const;

/** Wave from which the arena goes dark in every mode. */
export const DARKNESS_START_WAVE = GAME_CONFIG.DARKNESS_START_WAVE;
/** Wave that hosts the Black Devil encounter in every mode. */
export const BLACK_DEVIL_START_WAVE = GAME_CONFIG.BLACK_DEVIL_START_WAVE;

/**
 * Whether the darkness / night lighting should be engaged this frame.
 *
 * Two independent triggers share the one rig: the permanent darkness band that
 * begins at `DARKNESS_START_WAVE` (Solo, local co-op and online alike) and the
 * one-wave `blackout` themed event, which is darkest of all. The client calls
 * this each frame with its director wave (local offline, room-mirrored online),
 * so changing `DARKNESS_START_WAVE` moves the night in every mode at once.
 */
export function darknessActive(wave: number, blackoutEvent = false): boolean {
  return blackoutEvent || (Number.isInteger(wave) && wave >= GAME_CONFIG.DARKNESS_START_WAVE);
}
