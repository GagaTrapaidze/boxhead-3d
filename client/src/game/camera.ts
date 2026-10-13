/**
 * Camera controller — angled isometric (Boxhead style).
 * single: follows the local player with slight damping.
 * duo:    dynamic bounding box around both players — pans and zooms so the
 *         whole squad always fits the viewport.
 */
import { SINGLE_VIEW_HEIGHT } from './world.ts';
import type { World } from './world.ts';
import type { Player } from './player.ts';
import { JUICE_CONFIG } from '../../../shared/src/balance.config.ts';

const FOLLOW_LERP = 5; // damping strength (1/s)
const ZOOM_LERP = 3.5;
const DUO_PADDING = 8; // world units of margin around the squad
const DUO_MIN_HALF = SINGLE_VIEW_HEIGHT / 2;
const DUO_MAX_HALF = 34;

// Isometric camera angle: ~55 degrees pitch for depth/height emphasis
export const CAMERA_HEIGHT = 38;
export const CAMERA_ANGLE = Math.PI / 3.2; // ~56 degrees from horizontal

/** Camera position for an isometric view looking down at the center. */
function isometricPosition(centerX: number, centerZ: number): { x: number; y: number; z: number } {
  const dist = CAMERA_HEIGHT / Math.sin(CAMERA_ANGLE);
  const height = CAMERA_HEIGHT;
  const offset = dist * Math.cos(CAMERA_ANGLE);
  return {
    x: centerX,
    y: height,
    z: centerZ + offset, // camera is "north" of center, looking south-down
  };
}

export class CameraController {
  private centerX: number;
  private centerZ: number;
  private halfHeight: number;
  /** Impulse-driven screen-shake energy, in [0, 1]. */
  private trauma = 0;
  /** Unit vector of the last directional rumble (barrel chains). */
  private biasX = 0;
  private biasZ = 0;
  /** Advances the shake oscillators (seconds). */
  private shakeClock = 0;

  constructor(
    private readonly world: World,
    private readonly mode: 'single' | 'duo',
    start: { x: number; z: number }
  ) {
    this.centerX = start.x;
    this.centerZ = start.z;
    this.halfHeight = DUO_MIN_HALF;
    this.apply();
  }

  /**
   * Adds screen-shake energy (clamped to 1). An optional direction produces a
   * directional rumble — used by barrel chain explosions to kick toward the blast.
   */
  addTrauma(amount: number, dirX = 0, dirZ = 0): void {
    this.trauma = Math.min(1, this.trauma + amount);
    if (dirX !== 0 || dirZ !== 0) {
      const length = Math.hypot(dirX, dirZ);
      this.biasX = dirX / length;
      this.biasZ = dirZ / length;
    }
  }

  update(players: readonly Player[], dt: number): void {
    this.shakeClock += dt;
    this.trauma = Math.max(0, this.trauma - JUICE_CONFIG.traumaDecay * dt);
    this.biasX *= Math.max(0, 1 - JUICE_CONFIG.traumaDecay * 1.5 * dt);
    this.biasZ *= Math.max(0, 1 - JUICE_CONFIG.traumaDecay * 1.5 * dt);
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    let targetX = this.centerX;
    let targetZ = this.centerZ;
    let targetHalf = this.halfHeight;

    if (this.mode === 'single' || players.length <= 1) {
      const player = players[0];
      if (player) {
        targetX = player.x;
        targetZ = player.z;
      }
      targetHalf = SINGLE_VIEW_HEIGHT / 2;
    } else {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const player of players) {
        if (!player.alive) continue;
        minX = Math.min(minX, player.x);
        maxX = Math.max(maxX, player.x);
        minZ = Math.min(minZ, player.z);
        maxZ = Math.max(maxZ, player.z);
      }
      if (Number.isFinite(minX)) {
        targetX = (minX + maxX) / 2;
        targetZ = (minZ + maxZ) / 2;
        const halfByHeight = (maxZ - minZ) / 2 + DUO_PADDING;
        const halfByWidth = (maxX - minX) / 2 + DUO_PADDING;
        targetHalf = Math.max(DUO_MIN_HALF, halfByHeight, halfByWidth / aspect);
        targetHalf = Math.min(DUO_MAX_HALF, targetHalf);
      }
    }

    const followK = 1 - Math.exp(-FOLLOW_LERP * dt);
    const zoomK = 1 - Math.exp(-ZOOM_LERP * dt);
    this.centerX += (targetX - this.centerX) * followK;
    this.centerZ += (targetZ - this.centerZ) * followK;
    this.halfHeight += (targetHalf - this.halfHeight) * zoomK;
    this.apply();
  }

  private apply(): void {
    const camera = this.world.camera;
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const halfWidth = this.halfHeight * aspect;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = this.halfHeight;
    camera.bottom = -this.halfHeight;

    // Trauma-squared falloff: small hits barely move, big ones slam the view.
    const shake = this.trauma * this.trauma;
    const offset = shake * JUICE_CONFIG.shakeMaxOffset;
    const f = JUICE_CONFIG.shakeFrequency * this.shakeClock;
    const noiseX = Math.sin(f) * 0.6 + Math.sin(f * 2.3) * 0.4;
    const noiseZ = Math.cos(f * 1.7) * 0.6 + Math.cos(f * 3.1) * 0.4;
    const ox = noiseX * offset + this.biasX * offset * 1.6;
    const oz = noiseZ * offset + this.biasZ * offset * 1.6;

    const pos = isometricPosition(this.centerX, this.centerZ);
    camera.position.set(pos.x + ox, pos.y, pos.z + oz);
    camera.lookAt(this.centerX + ox * 0.5, 0, this.centerZ + oz * 0.5);
    camera.rotation.z += this.biasX * shake * JUICE_CONFIG.shakeMaxRoll + noiseX * shake * JUICE_CONFIG.shakeMaxRoll;
    camera.updateProjectionMatrix();
  }
}
