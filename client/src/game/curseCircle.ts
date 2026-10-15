/**
 * Black Devil "Curse" cleansing circle — a 2 u zone drawn on the floor around
 * every cursed player.
 *
 * It doubles as the co-op progress indicator: a teammate standing inside fills
 * a bright radial arc (and swells an inner glow) toward a full 3 s cleanse.
 * Meshes, canvases and textures are allocated once in a small pool and reused
 * for the whole match, so a curse never allocates GPU resources mid-wave.
 */
import * as THREE from 'three';

import { CURSE_RADIUS } from '../../../shared/src/curse.ts';

/** Canvas resolution of each circle texture (px). */
const TEXTURE_SIZE = 256;
/** Simultaneous cursed players a single room can ever show (MAX_PLAYERS). */
const POOL_SIZE = 4;

/** One placeable cleansing zone. */
export interface CursedMarker {
  x: number;
  z: number;
  /** Cleanse hold progress (0..1). */
  progress: number;
}

interface CircleSlot {
  mesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  ctx: CanvasRenderingContext2D;
  lastProgress: number;
}

export class CurseCircle {
  private readonly slots: CircleSlot[] = [];

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = TEXTURE_SIZE;
      canvas.height = TEXTURE_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable');
      const texture = new THREE.CanvasTexture(canvas);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(CURSE_RADIUS * 2, CURSE_RADIUS * 2),
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.055; // just above the floor, below actors
      mesh.renderOrder = 3;
      mesh.visible = false;
      scene.add(mesh);
      this.slots.push({ mesh, canvas, texture, ctx, lastProgress: -1 });
    }
  }

  /** Positions one zone per cursed player and hides the rest of the pool. */
  update(markers: readonly CursedMarker[]): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const marker = markers[i];
      if (!marker) {
        slot.mesh.visible = false;
        slot.lastProgress = -1; // force a repaint the next time it appears
        continue;
      }
      slot.mesh.visible = true;
      slot.mesh.position.set(marker.x, 0.055, marker.z);
      if (Math.abs(marker.progress - slot.lastProgress) > 0.004) {
        this.draw(slot, marker.progress);
      }
    }
  }

  /** Hides every zone (menu / restart / leaving a room). */
  hide(): void {
    for (const slot of this.slots) {
      slot.mesh.visible = false;
      slot.lastProgress = -1;
    }
  }

  private draw(slot: CircleSlot, progress: number): void {
    slot.lastProgress = progress;
    const ctx = slot.ctx;
    const centre = TEXTURE_SIZE / 2;
    const radiusPx = ((CURSE_RADIUS - 0.12) / CURSE_RADIUS) * (TEXTURE_SIZE / 2);
    ctx.clearRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

    // faint curse haze filling the whole 2 u zone
    const glow = ctx.createRadialGradient(centre, centre, radiusPx * 0.2, centre, centre, radiusPx);
    glow.addColorStop(0, 'rgba(180, 77, 255, 0.05)');
    glow.addColorStop(1, 'rgba(180, 77, 255, 0.16)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(centre, centre, radiusPx, 0, Math.PI * 2);
    ctx.fill();

    // the cleansing boundary — exactly CURSE_RADIUS world units across
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(200, 107, 255, 0.7)';
    ctx.setLineDash([16, 10]);
    ctx.beginPath();
    ctx.arc(centre, centre, radiusPx - 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // radial cleanse hold, clockwise from the top (the progress indicator)
    if (progress > 0) {
      const clamped = Math.min(1, progress);
      ctx.lineWidth = 13;
      ctx.strokeStyle = '#7cf0ff';
      ctx.shadowColor = 'rgba(124, 240, 255, 0.95)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(centre, centre, radiusPx - 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamped);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    slot.texture.needsUpdate = true;
  }
}
