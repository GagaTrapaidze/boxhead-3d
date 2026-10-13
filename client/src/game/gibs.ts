/**
 * Low-poly voxel gibs — small colored cubes that burst out of a dying actor,
 * bounce across the floor and fade out. Every mesh/material is allocated once
 * in the constructor and recycled, so a wave of deaths never allocates GPU
 * resources or triggers a GC spike. Tuning lives in `balance.config.ts`
 * (`JUICE_CONFIG`).
 */
import * as THREE from 'three';

import { JUICE_CONFIG } from '../../../shared/src/balance.config.ts';

/** White bone/flesh debris. */
const GIB_COLOR_LIGHT = 0xd8dde8;
/** Blood-red debris. */
const GIB_COLOR_DARK = 0xaa2222;
/** Cube edge length (world units) — chunky, readable from the isometric view. */
const GIB_SIZE = 0.16;
/** Resting height of a cube centre on the arena floor. */
const GIB_GROUND_Y = GIB_SIZE * 0.5;

interface Gib {
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  vx: number;
  vy: number;
  vz: number;
  spinX: number;
  spinZ: number;
  life: number;
  grounded: boolean;
}

export class GibLayer {
  private readonly gibs: Gib[] = [];
  private readonly geometry = new THREE.BoxGeometry(GIB_SIZE, GIB_SIZE, GIB_SIZE);

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < JUICE_CONFIG.gibPoolSize; i++) {
      // One material per pooled mesh (96 total, page-lifetime) so opacity can
      // be animated independently without ever allocating per burst.
      const mesh = new THREE.Mesh(
        this.geometry,
        new THREE.MeshStandardMaterial({ color: GIB_COLOR_LIGHT, roughness: 0.75 })
      );
      mesh.visible = false;
      mesh.castShadow = false;
      scene.add(mesh);
      this.gibs.push({ mesh, vx: 0, vy: 0, vz: 0, spinX: 0, spinZ: 0, life: 0, grounded: false });
    }
  }

  /** Spawns `count` cubes at a world position with random outward velocity. */
  burst(x: number, z: number, count: number): void {
    let spawned = 0;
    for (const gib of this.gibs) {
      if (spawned >= count) break;
      if (gib.life > 0) continue;
      this.launch(gib, x, z);
      spawned++;
    }
  }

  private launch(gib: Gib, x: number, z: number): void {
    const angle = Math.random() * Math.PI * 2;
    const speed = JUICE_CONFIG.gibSpeedMin + Math.random() * (JUICE_CONFIG.gibSpeedMax - JUICE_CONFIG.gibSpeedMin);
    gib.mesh.material.color.setHex(Math.random() < 0.55 ? GIB_COLOR_DARK : GIB_COLOR_LIGHT);
    gib.mesh.material.opacity = 1;
    gib.mesh.material.transparent = true;
    gib.mesh.position.set(x, 0.5 + Math.random() * 0.4, z);
    gib.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    gib.mesh.scale.setScalar(0.7 + Math.random() * 0.7);
    gib.mesh.visible = true;
    gib.vx = Math.cos(angle) * speed;
    gib.vz = Math.sin(angle) * speed;
    gib.vy = 3.5 + Math.random() * 3.5;
    gib.spinX = (Math.random() - 0.5) * 12;
    gib.spinZ = (Math.random() - 0.5) * 12;
    gib.life = JUICE_CONFIG.gibLifeSeconds;
    gib.grounded = false;
  }

  update(dt: number): void {
    for (const gib of this.gibs) {
      if (gib.life <= 0) continue;
      gib.life -= dt;
      if (gib.life <= 0) {
        gib.life = 0;
        gib.mesh.visible = false;
        continue;
      }

      if (!gib.grounded) {
        gib.vy -= JUICE_CONFIG.gibGravity * dt;
        gib.mesh.position.x += gib.vx * dt;
        gib.mesh.position.y += gib.vy * dt;
        gib.mesh.position.z += gib.vz * dt;
        gib.mesh.rotation.x += gib.spinX * dt;
        gib.mesh.rotation.z += gib.spinZ * dt;
        if (gib.mesh.position.y <= GIB_GROUND_Y) {
          gib.mesh.position.y = GIB_GROUND_Y;
          gib.vy = Math.abs(gib.vy) * 0.32; // damped floor bounce
          gib.vx *= 0.6;
          gib.vz *= 0.6;
          gib.spinX *= 0.5;
          gib.spinZ *= 0.5;
          if (gib.vy < 0.6) {
            gib.vy = 0;
            gib.grounded = true;
          }
        }
      }

      // Fade the last third of the life (material is per-instance, so opacity
      // is safe to animate).
      const fade = Math.min(1, gib.life / (JUICE_CONFIG.gibLifeSeconds * 0.35));
      gib.mesh.material.opacity = fade;
    }
  }

  /** Hides every gib (menu / restart). */
  reset(): void {
    for (const gib of this.gibs) {
      gib.life = 0;
      gib.mesh.visible = false;
    }
  }
}
