/**
 * Darkness / night-wave lighting.
 *
 * From `GAME_CONFIG.DARKNESS_START_WAVE` (shared/src/gameConfig.ts) onward the
 * arena stays dark in every mode — Solo, local co-op and online — and from a
 * themed blackout event the same rig runs even darker for its single wave. The
 * ambient and directional lights ease down, a night fog closes in, and every
 * player carries a flashlight: a THREE.SpotLight cone aimed along their current
 * facing. Zombies stay hidden in the dark until they walk into a cone — or are
 * briefly revealed by a muzzle flash (FxLayer) or an explosion blast
 * (projectiles.ts). The zombie-eye glow is muted in lockstep so no pair of red
 * dots betrays the horde. `reset()` restores full daylight on a restart.
 */
import * as THREE from 'three';

import type { World } from './world.ts';
import type { Player } from './player.ts';
import { ZOMBIE_EYE_GLOW, setZombieEyeGlow } from './actors.ts';

/** Ambient intensities of a normal wave (mirrors createWorld's defaults). */
const DAY = { sun: 1.2, hemi: 0.6, fill: 0.3 };
/** Near pitch-black ambient while the blackout is fully engaged. */
const NIGHT = { sun: 0.03, hemi: 0.04, fill: 0.0 };
/** Seconds for the ambient rig to ease between day and blackout. */
const BLEND_SECONDS = 0.8;

/**
 * Linear fog distances. By day the fog sits far beyond the camera (so it is
 * invisible); the darkness eases it down into a soft haze that swallows the
 * far side of the arena and sells the night atmosphere.
 */
const DAY_FOG = { near: 1_000_000, far: 2_000_000 };
const NIGHT_FOG = { near: 24, far: 80 };

const FLASHLIGHT_RANGE = 15; // cone reach in world units
const FLASHLIGHT_ANGLE = 0.45; // half-angle of the cone (~26°)
const FLASHLIGHT_INTENSITY = 70;
/** Aiming point distance ahead of the player (along their facing). */
const FLASHLIGHT_AIM_DISTANCE = 8;

interface Flashlight {
  light: THREE.SpotLight;
  target: THREE.Object3D;
}

export class NightMode {
  private active = false;
  /** 0 = full daylight, 1 = full blackout (eased, never snapped). */
  private blend = 0;
  /** One flashlight per player, created lazily and reused across matches. */
  private readonly flashlights: Flashlight[] = [];
  /**
   * The arena's night fog. Always attached to the scene — by day it is pushed
   * far past the camera — so easing it in never forces a shader recompile.
   */
  private readonly fog = new THREE.Fog(0x05070f, DAY_FOG.near, DAY_FOG.far);

  constructor(private readonly world: World) {
    this.world.scene.fog = this.fog;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Current dimming factor 0..1 (HUD/debug readout). */
  get darkness(): number {
    return this.blend;
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  /** Restores daylight and hides every flashlight (menu/restart). */
  reset(): void {
    this.active = false;
    this.blend = 0;
    this.applyBlend();
    for (const flashlight of this.flashlights) flashlight.light.visible = false;
  }

  /** Eases the ambient rig and re-aims the flashlights for this frame. */
  update(dt: number, players: readonly Player[]): void {
    const target = this.active ? 1 : 0;
    const step = dt / BLEND_SECONDS;
    const delta = target - this.blend;
    this.blend += Math.sign(delta) * Math.min(step, Math.abs(delta));
    this.applyBlend();
    this.syncFlashlights(players);
  }

  private applyBlend(): void {
    const t = this.blend;
    this.world.sunLight.intensity = DAY.sun + (NIGHT.sun - DAY.sun) * t;
    this.world.hemiLight.intensity = DAY.hemi + (NIGHT.hemi - DAY.hemi) * t;
    this.world.fillLight.intensity = DAY.fill + (NIGHT.fill - DAY.fill) * t;
    // fog closes in with the darkness for a hazy, cloistered night.
    this.fog.near = DAY_FOG.near + (NIGHT_FOG.near - DAY_FOG.near) * t;
    this.fog.far = DAY_FOG.far + (NIGHT_FOG.far - DAY_FOG.far) * t;
    // eyes fade with the darkness so no glow betrays the shadows
    setZombieEyeGlow(ZOMBIE_EYE_GLOW * (1 - t));
  }

  /** Pools one flashlight per player slot and points it along their facing. */
  private syncFlashlights(players: readonly Player[]): void {
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      let flashlight = this.flashlights[i];
      if (!flashlight) {
        const light = new THREE.SpotLight(
          0xfff3d0,
          FLASHLIGHT_INTENSITY,
          FLASHLIGHT_RANGE,
          FLASHLIGHT_ANGLE,
          0.35, // penumbra: soft cone edge
          1.8 // decay: near-physical falloff
        );
        light.castShadow = false; // cone lighting only — per-player shadows too costly
        const target = new THREE.Object3D();
        this.world.scene.add(light, target);
        light.target = target;
        flashlight = { light, target };
        this.flashlights.push(flashlight);
      }
      // beam origin just above the head, aimed at a point ahead of the facing
      flashlight.light.visible = this.active;
      flashlight.light.position.set(player.x, 1.7, player.z);
      flashlight.target.position.set(
        player.x + player.aimX * FLASHLIGHT_AIM_DISTANCE,
        0,
        player.z + player.aimZ * FLASHLIGHT_AIM_DISTANCE
      );
    }
    // hide any leftover flashlights from a larger previous player count
    for (let i = players.length; i < this.flashlights.length; i++) {
      this.flashlights[i].light.visible = false;
    }
  }
}
