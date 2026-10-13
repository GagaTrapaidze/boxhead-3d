/**
 * Glowing revive circle — the co-op "high-five" fast-track.
 *
 * A single additive-blended plane lies on the floor around the downed player;
 * its canvas texture redraws a glowing base ring plus a radial hold-progress
 * arc (yellow) while a partner stands inside. Geometry and texture are created
 * once and reused for the whole match — `show()` only repositions the plane
 * and repaints the arc when the progress actually moves.
 */
import * as THREE from 'three';

import { COOP_CONFIG } from '../../../shared/src/balance.config.ts';

/** Canvas resolution of the ring texture (px). */
const TEXTURE_SIZE = 256;
/** Ring radius in world units (the plane covers the circle's diameter). */
const RADIUS = COOP_CONFIG.reviveCircleRadius;

export class ReviveCircle {
  readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  /** Last painted progress, so tiny dt steps never force a repaint. */
  private lastProgress = -1;

  constructor(scene: THREE.Scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = TEXTURE_SIZE;
    this.canvas.height = TEXTURE_SIZE;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(RADIUS * 2, RADIUS * 2),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.06; // just above the floor, below actors
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.draw(0);
  }

  /** Positions the circle and refreshes the hold-progress arc (0..1). */
  show(x: number, z: number, progress: number): void {
    this.mesh.position.set(x, 0.06, z);
    this.mesh.visible = true;
    if (Math.abs(progress - this.lastProgress) > 0.004) this.draw(progress);
  }

  hide(): void {
    this.mesh.visible = false;
    this.lastProgress = -1; // force a repaint the next time it appears
  }

  private draw(progress: number): void {
    this.lastProgress = progress;
    const ctx = this.ctx;
    const centre = TEXTURE_SIZE / 2;
    // keep the drawn ring slightly inside the plane's edge
    const radiusPx = ((RADIUS - 0.15) / RADIUS) * (TEXTURE_SIZE / 2);
    ctx.clearRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

    // faint inner glow
    const glow = ctx.createRadialGradient(centre, centre, radiusPx * 0.3, centre, centre, radiusPx);
    glow.addColorStop(0, 'rgba(124, 231, 162, 0.05)');
    glow.addColorStop(1, 'rgba(124, 231, 162, 0.18)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(centre, centre, radiusPx, 0, Math.PI * 2);
    ctx.fill();

    // glowing base ring
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(124, 231, 162, 0.6)';
    ctx.beginPath();
    ctx.arc(centre, centre, radiusPx - 6, 0, Math.PI * 2);
    ctx.stroke();

    // radial hold-progress arc, clockwise from the top
    if (progress > 0) {
      const clamped = Math.min(1, progress);
      ctx.lineWidth = 13;
      ctx.strokeStyle = '#ffd35c';
      ctx.shadowColor = 'rgba(255, 211, 92, 0.9)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(centre, centre, radiusPx - 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamped);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    this.texture.needsUpdate = true;
  }
}
