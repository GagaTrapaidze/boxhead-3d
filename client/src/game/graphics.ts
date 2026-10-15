/**
 * Graphics quality — a single pre-game HIGH / LOW ("potato mode") switch that
 * owns every render-cost knob: real-time shadows, dynamic lights, particle
 * counts and the device pixel ratio.
 *
 * The choice lives in `localStorage` (`graphicsQuality`, default HIGH) so it
 * survives across matches and reloads. The scene is registered once at startup
 * (`registerGraphicsWorld`), after which flipping the toggle repaints the live
 * world immediately and every match (re)applies the mode as it builds its arena.
 */
import * as THREE from 'three';

import type { World } from './world.ts';

export type GraphicsQuality = 'HIGH' | 'LOW';

/** localStorage key (read by tooling/tests as `graphicsQuality`). */
export const GRAPHICS_QUALITY_KEY = 'graphicsQuality';
/** HIGH caps the pixel ratio here; LOW forces a flat 1×. */
const HIGH_PIXEL_RATIO_CAP = 2;

function readStoredQuality(): GraphicsQuality {
  try {
    return window.localStorage.getItem(GRAPHICS_QUALITY_KEY) === 'LOW' ? 'LOW' : 'HIGH';
  } catch {
    return 'HIGH'; // private mode can throw on access
  }
}

/** The user's selected mode (defaults to HIGH). */
let quality: GraphicsQuality = readStoredQuality();
/** Scene currently receiving the mode (set once by main.ts at startup). */
let activeWorld: World | null = null;
/**
 * Per-object shadow flags captured before LOW cleared them, so HIGH can restore
 * exactly what was there. Keyed by object, so meshes rebuilt on a map swap are
 * re-registered the next time LOW is applied.
 */
const shadowFlags = new WeakMap<THREE.Object3D, { cast: boolean; receive: boolean }>();

export function getGraphicsQuality(): GraphicsQuality {
  return quality;
}

/** True in "potato mode" — FX layers read this to thin out particles/lights. */
export function isLowQuality(): boolean {
  return quality === 'LOW';
}

/** Binds the live scene and applies the stored mode to it (startup). */
export function registerGraphicsWorld(world: World): void {
  activeWorld = world;
  applyGraphicsQuality(world);
}

/** Persists the choice and applies it to the live scene immediately. */
export function setGraphicsQuality(next: GraphicsQuality): void {
  quality = next;
  try {
    window.localStorage.setItem(GRAPHICS_QUALITY_KEY, next);
  } catch {
    /* storage unavailable — the choice just won't persist */
  }
  if (activeWorld) applyGraphicsQuality(activeWorld);
}

/**
 * Applies the selected mode to `world`.
 *
 * HIGH: real-time shadows on, dynamic lights on, native device pixel ratio.
 * LOW: shadow-map pass fully disabled (`shadowMap.enabled = false` plus every
 * mesh's cast/receive flags cleared), dynamic muzzle/blast lights muted, and a
 * flat 1x pixel ratio. The ambient hemisphere + directional lights are always
 * kept, so the arena stays clearly lit in either mode.
 */
export function applyGraphicsQuality(world: World): void {
  const low = quality === 'LOW';
  const { renderer, scene, sunLight } = world;

  // Real-time shadows: HIGH renders them; LOW skips the shadow-map pass entirely.
  renderer.shadowMap.enabled = !low;
  sunLight.castShadow = !low;

  if (low) {
    scene.traverse((object) => {
      if (object.castShadow || object.receiveShadow) {
        shadowFlags.set(object, { cast: object.castShadow, receive: object.receiveShadow });
      }
      object.castShadow = false;
      object.receiveShadow = false;
    });
  } else {
    scene.traverse((object) => {
      const saved = shadowFlags.get(object);
      if (saved) {
        object.castShadow = saved.cast;
        object.receiveShadow = saved.receive;
      }
    });
  }

  // Resolution: native (capped) when HIGH, a hard 1x in LOW so 2K/4K high-DPI
  // displays never render at a punishing pixel count.
  renderer.setPixelRatio(low ? 1 : Math.min(window.devicePixelRatio, HIGH_PIXEL_RATIO_CAP));
  renderer.shadowMap.needsUpdate = true;
}
