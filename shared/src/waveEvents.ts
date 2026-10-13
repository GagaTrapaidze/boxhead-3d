// ---------------------------------------------------------------------------
// Special wave events — themed variant waves that break combat monotony.
//
//  - Speed Horde (waves 4, 12, 20 …): exclusively lightweight Runner zombies
//    moving +80% faster (40 HP keeps them fragile).
//  - Blackout (waves 8, 16, 24 …): the arena dims to near pitch-black and each
//    player carries a flashlight cone; the horde hides in the shadows.
//
// The cadence lives in `WAVE_EVENT_CONFIG` (balance.config.ts) so the wave
// director, the renderer and the tests all agree on which wave hosts what.
// ---------------------------------------------------------------------------

import { WAVE_EVENT_CONFIG } from './balance.config.ts';
import type { WaveEventKind } from './balance.config.ts';

// Re-exported so callers can `import { WaveEventKind } from './waveEvents.ts'`.
export type { WaveEventKind };

/** The themed event hosting `wave`, or 'none' for a standard wave. */
export function waveEventFor(wave: number): WaveEventKind {
  if (!Number.isInteger(wave) || wave <= 0) return 'none';
  const { period, speedHordeOffset, blackoutOffset } = WAVE_EVENT_CONFIG;
  if (wave % period === speedHordeOffset) return 'speedHorde';
  if (wave % period === blackoutOffset) return 'blackout';
  return 'none';
}

/** Display label for an event wave (HUD banner / toast). */
export function waveEventLabel(event: WaveEventKind): string | null {
  if (event === 'speedHorde') return 'SPEED HORDE!';
  if (event === 'blackout') return 'BLACKOUT!';
  return null;
}
