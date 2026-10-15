// ---------------------------------------------------------------------------
// Special wave events — themed variant waves that break combat monotony.
//
//  - Speed Horde (waves 4, 12, 20 …): exclusively lightweight Runner zombies
//    moving +80% faster (40 HP keeps them fragile).
//  - Blackout (first wave `GAME_CONFIG.DARKNESS_START_WAVE`, then every `period`
//    waves): the arena dims to near pitch-black and each player carries a
//    flashlight cone; the horde hides in the shadows. These blackout waves ARE
//    the dark waves — there is no separate permanent night band — so one
//    cadence drives both the event banner and the lighting rig.
//
// The cadence lives in `WAVE_EVENT_CONFIG` (balance.config.ts), whose blackout
// wave derives from `GAME_CONFIG.DARKNESS_START_WAVE` (gameConfig.ts), so the
// director, the renderer and the tests all agree on which wave hosts what.
// ---------------------------------------------------------------------------

import { WAVE_EVENT_CONFIG } from './balance.config.ts';
import type { WaveEventKind } from './balance.config.ts';
import { BLACKOUT_EVENT_WAVE } from './gameConfig.ts';

// Re-exported so callers can `import { WaveEventKind } from './waveEvents.ts'`.
export type { WaveEventKind };

/** The themed event hosting `wave`, or 'none' for a standard wave. */
export function waveEventFor(wave: number): WaveEventKind {
  if (!Number.isInteger(wave) || wave <= 0) return 'none';
  const { period, speedHordeOffset, blackoutOffset } = WAVE_EVENT_CONFIG;
  if (wave % period === speedHordeOffset) return 'speedHorde';
  // `wave >= BLACKOUT_EVENT_WAVE` pins the FIRST blackout exactly on the
  // configured wave, even if `period` does not divide it (the modulo alone
  // would otherwise pull the first blackout back before it).
  if (wave >= BLACKOUT_EVENT_WAVE && wave % period === blackoutOffset) return 'blackout';
  return 'none';
}

/** Display label for an event wave (HUD banner / toast). */
export function waveEventLabel(event: WaveEventKind): string | null {
  if (event === 'speedHorde') return 'SPEED HORDE!';
  if (event === 'blackout') return 'BLACKOUT!';
  return null;
}

/**
 * Whether the darkness / night lighting is engaged on `wave`.
 *
 * Darkness is exactly the periodic `blackout` event — the arena is bright on
 * every other wave. Called each frame with the director wave (local offline,
 * room-mirrored online), so editing `GAME_CONFIG.DARKNESS_START_WAVE` moves the
 * night in Solo, local co-op and online at once. `blackoutEvent` short-circuits
 * for a caller that already knows the (possibly mirrored) director event.
 */
export function darknessActive(wave: number, blackoutEvent = false): boolean {
  return blackoutEvent || waveEventFor(wave) === 'blackout';
}
