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
 *  - `DARKNESS_START_WAVE` — the first wave darkness falls. Darkness IS the
 *    periodic one-wave `blackout` (lights-out) event: it hits this wave and
 *    then every `WAVE_EVENT_CONFIG.period` waves (6, 14, 22 … with the default
 *    period of 8), and the arena is bright in between. There is no separate
 *    permanent night band. The client lighting rig reads it each frame, so the
 *    darkness cadence is identical in every mode.
 *  - `BLACK_DEVIL_START_WAVE` — the earliest wave the Black Devil may spawn.
 *    The hard `BLACK_DEVIL_MIN_WAVE` floor derives from it and clamps the boss
 *    on the client director and the server world alike. The wave that actually
 *    hosts the encounter is tuned via `DIRECTOR_CONFIG.blackDevilWave` in
 *    balance.config.ts.
 *  - `SHOCKWAVE_EXPANSION_SPEED` — world units/second the boss shockwave ring
 *    expands at (the server authority and the offline client AI share it).
 *
 * `balance.config.ts` imports and re-exports these so gameplay tuning stays
 * centralized there while these mode-spanning values live in exactly one file.
 */
export const GAME_CONFIG = {
  /**
   * First wave darkness falls. Darkness is a periodic one-wave `blackout`
   * event — there is NO permanent night band — so this single number drives the
   * whole cadence: it hits this wave, then every `WAVE_EVENT_CONFIG.period`
   * waves after it (6, 14, 22 … with the default period of 8). Edit this one
   * number to move the first dark wave. `shared/test/gameConfig.test.ts` guards
   * it.
   */
  DARKNESS_START_WAVE: 6,
  /** Earliest wave the Black Devil boss may spawn (the safety floor). The wave
   * that actually hosts it is `DIRECTOR_CONFIG.blackDevilWave` in
   * balance.config.ts. */
  BLACK_DEVIL_START_WAVE: 7,
  /** Expansion speed of the Black Devil's shockwave ring (world units/second). */
  SHOCKWAVE_EXPANSION_SPEED: 12,
} as const;

/** First wave darkness falls in every mode (see `darknessActive` in waveEvents.ts). */
export const DARKNESS_START_WAVE = GAME_CONFIG.DARKNESS_START_WAVE;
/**
 * First wave hosting the periodic `blackout` (lights-out) event. Darkness and
 * the event are the very same waves, so this is DERIVED from
 * `DARKNESS_START_WAVE`: editing that one number moves the event, its
 * `WAVE_EVENT_CONFIG.blackoutOffset` cadence and the lighting together — the
 * two can never drift apart.
 */
export const BLACKOUT_EVENT_WAVE = GAME_CONFIG.DARKNESS_START_WAVE;
/** Earliest wave the Black Devil may spawn in every mode (see balance.config.ts). */
export const BLACK_DEVIL_START_WAVE = GAME_CONFIG.BLACK_DEVIL_START_WAVE;

// Darkness is not a separate band: `darknessActive` lives in `waveEvents.ts`,
// next to the `blackout` cadence it is derived from.
