/**
 * Black Devil boss FX — the telegraphed laser and the radial shockwave.
 *
 * All three meshes (thin aim line, thick beam, expanding ring) are allocated
 * once and driven by visibility/transform, so a boss fight never allocates GPU
 * resources mid-wave. The layer is purely cosmetic: it reads the *already
 * simulated* boss state (the local AI offline, the server's schema online), so
 * both clients paint an identical telegraph, beam direction and shockwave.
 */
import * as THREE from 'three';

import { ENEMY_CONFIG } from '../../../shared/src/balance.config.ts';
import type { Zombie } from './enemies.ts';

const BLACK_DEVIL = ENEMY_CONFIG.blackDevil;

/** Beam/aim-line length falls back to the configured laser reach. */
const LASER_RANGE = BLACK_DEVIL.laserRange;
/** Beam height above the floor (roughly the boss's chest). */
const BEAM_Y = 1.1;
/** Fallback shockwave ring lifetime when a speed is not supplied. */
const RING_LIFE = 0.45;

/** One expanding shockwave ring. */
interface ShockwaveRing {
  mesh: THREE.Mesh;
  /** Outer world radius the ring expands to. */
  maxRadius: number;
  /** World units/second the ring grows (matches the server's collision sweep). */
  speed: number;
  /** Seconds elapsed since the ring was fired. */
  age: number;
  /** Total expansion time (`maxRadius / speed`, or `RING_LIFE` as a floor). */
  duration: number;
}

export class BossFx {
  private readonly aimLine: THREE.Mesh;
  private readonly aimMaterial: THREE.MeshBasicMaterial;
  private readonly beam: THREE.Mesh;
  private readonly beamMaterial: THREE.MeshBasicMaterial;
  private readonly rings: ShockwaveRing[] = [];
  private ringCursor = 0;
  private pulse = 0;

  constructor(private readonly scene: THREE.Scene) {
    // Unit boxes scaled along local +Z (the aim direction of the boss).
    const unitBox = new THREE.BoxGeometry(1, 1, 1);

    this.aimMaterial = new THREE.MeshBasicMaterial({
      color: 0x9a4dff,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this.aimLine = new THREE.Mesh(unitBox, this.aimMaterial);
    this.aimLine.visible = false;
    this.aimLine.renderOrder = 3;
    this.scene.add(this.aimLine);

    this.beamMaterial = new THREE.MeshBasicMaterial({
      color: 0xc86bff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.beam = new THREE.Mesh(unitBox, this.beamMaterial);
    this.beam.visible = false;
    this.beam.renderOrder = 3;
    this.scene.add(this.beam);

    // A small pool of rings so overlapping shockwaves never allocate.
    const ringGeometry = new THREE.RingGeometry(0.82, 1, 44);
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(
        ringGeometry,
        new THREE.MeshBasicMaterial({
          color: 0xb44dff,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.07;
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      this.rings.push({ mesh, maxRadius: 0, speed: 0, age: 0, duration: RING_LIFE });
    }
  }

  /** Paints the telegraph / beam for whichever Black Devil is channeling. */
  update(dt: number, zombies: readonly Zombie[]): void {
    this.pulse += dt;
    let showedAim = false;
    let showedBeam = false;

    for (const zombie of zombies) {
      if (zombie.kind !== 'blackDevil' || !zombie.alive) continue;
      if (zombie.attackState === 'idle') continue;
      const dirX = zombie.laserDirX;
      const dirZ = zombie.laserDirZ;
      if (dirX === 0 && dirZ === 0) continue;
      // The beam/aim line is clamped to the server's continuous raycast hit, so
      // it stops dead at the wall / crate it struck and never renders through
      // cover (0 = the boss is flush against a wall: draw nothing).
      const clamped = Math.max(0, Math.min(zombie.laserLength || 0, LASER_RANGE));
      if (clamped < 0.05) continue;
      const yaw = Math.atan2(dirX, dirZ);
      const midX = zombie.x + dirX * (clamped / 2);
      const midZ = zombie.z + dirZ * (clamped / 2);

      if (zombie.attackState === 'charge') {
        // Thin, faint aim line — locked onto the targeted player as a warning.
        this.aimLine.visible = true;
        this.aimLine.position.set(midX, BEAM_Y, midZ);
        this.aimLine.rotation.y = yaw;
        this.aimLine.scale.set(0.08, 0.08, clamped);
        this.aimMaterial.opacity = 0.22 + Math.sin(this.pulse * 18) * 0.14;
        showedAim = true;
      } else {
        // Thick continuous beam.
        this.beam.visible = true;
        this.beam.position.set(midX, BEAM_Y, midZ);
        this.beam.rotation.y = yaw;
        this.beam.scale.set(0.55, 0.55, clamped);
        this.beamMaterial.opacity = 0.7 + Math.sin(this.pulse * 40) * 0.12;
        showedBeam = true;
      }
    }

    if (!showedAim) this.aimLine.visible = false;
    if (!showedBeam) this.beam.visible = false;

    // Expand and fade the shockwave rings at the server's expansion speed.
    for (const ring of this.rings) {
      if (ring.duration <= 0 || ring.age >= ring.duration) continue;
      ring.age += dt;
      const progress = Math.min(1, ring.age / ring.duration);
      ring.mesh.scale.setScalar(ring.maxRadius * progress + 0.2);
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - progress);
      if (ring.age >= ring.duration) ring.mesh.visible = false;
    }
  }

  /**
   * Plays one expanding energy ring out to `radius` (world units).
   *
   * `speed` (world units/second) is the server's expansion speed, so the visual
   * ring reaches each victim at the exact tick the collision sweep does; the
   * ring's lifetime is therefore `radius / speed` rather than a fixed value.
   */
  shockwave(x: number, z: number, radius: number, speed?: number): void {
    const ring = this.rings[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % this.rings.length;
    const effectiveSpeed = speed && speed > 0 ? speed : radius / RING_LIFE;
    ring.maxRadius = radius;
    ring.speed = effectiveSpeed;
    ring.age = 0;
    ring.duration = effectiveSpeed > 0 ? Math.max(0.08, radius / effectiveSpeed) : RING_LIFE;
    ring.mesh.position.set(x, 0.07, z);
    ring.mesh.scale.setScalar(0.2);
    (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8;
    ring.mesh.visible = true;
  }

  /** Hides every boss FX mesh (menu / restart / leaving a room). */
  reset(): void {
    this.aimLine.visible = false;
    this.beam.visible = false;
    for (const ring of this.rings) {
      ring.age = ring.duration;
      ring.mesh.visible = false;
    }
  }
}
