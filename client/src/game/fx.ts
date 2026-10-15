/**
 * Pooled combat FX — bullet tracers, muzzle flashes and the muzzle light.
 *
 * Every line/mesh is allocated once in the constructor and then toggled with
 * `visible`, so firing never allocates GPU resources or creates garbage during
 * a wave. `reset()` hides everything on restart so nothing leaks across runs.
 */
import * as THREE from 'three';

import { FX_CONFIG } from '../../../shared/src/balance.config.ts';
import { isLowQuality } from './graphics.ts';

export const TRACER_LIFE = FX_CONFIG.tracerLife;
export const MUZZLE_FLASH_LIFE = FX_CONFIG.muzzleFlashLife;

const TRACER_POOL_SIZE = 96;
const FLASH_POOL_SIZE = 24;
const IMPACT_POOL_SIZE = 48;

interface Tracer {
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  life: number;
}

interface MuzzleFlash {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  life: number;
  scale: number;
}

/** A bullet-strikes-wall spark burst. */
interface Impact {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

export class FxLayer {
  private readonly tracers: Tracer[] = [];
  private readonly flashes: MuzzleFlash[] = [];
  private readonly impacts: Impact[] = [];
  private readonly flashGeometry = new THREE.SphereGeometry(1, 8, 6);
  private readonly muzzleLight: THREE.PointLight;
  private lightLife = 0;
  /** Alternating counter that halves wall-spark bursts in LOW quality. */
  private impactTick = 0;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < TRACER_POOL_SIZE; i++) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const material = new THREE.LineBasicMaterial({ transparent: true, opacity: 0 });
      const line = new THREE.Line(geometry, material);
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      this.tracers.push({ line, life: 0 });
    }

    for (let i = 0; i < FLASH_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(
        this.flashGeometry,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })
      );
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.flashes.push({ mesh, life: 0, scale: 1 });
    }

    for (let i = 0; i < IMPACT_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(
        this.flashGeometry,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })
      );
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.impacts.push({ mesh, life: 0 });
    }

    this.muzzleLight = new THREE.PointLight(0xffdd88, 0, 6, 2);
    scene.add(this.muzzleLight);
  }

  /** Draws a single tracer segment; reuses the first expired slot. */
  tracer(fromX: number, fromZ: number, toX: number, toZ: number, color: number, y = 0.7): void {
    const tracer = this.tracers.find((candidate) => candidate.life <= 0) ?? this.tracers[0];
    const position = tracer.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    position.setXYZ(0, fromX, y, fromZ);
    position.setXYZ(1, toX, y, toZ);
    position.needsUpdate = true;
    tracer.line.material.color.setHex(color);
    tracer.line.material.opacity = 0.9;
    tracer.line.visible = true;
    tracer.life = TRACER_LIFE;
  }

  /** Pulses a muzzle flash + the shared muzzle light at a world position. */
  muzzleFlash(x: number, z: number, scale: number, color: number, y = 0.9): void {
    const flash = this.flashes.find((candidate) => candidate.life <= 0) ?? this.flashes[0];
    flash.mesh.position.set(x, y, z);
    flash.mesh.material.color.setHex(color);
    flash.mesh.material.opacity = 0.9;
    flash.mesh.scale.setScalar(scale * 0.4);
    flash.mesh.visible = true;
    flash.life = MUZZLE_FLASH_LIFE;
    flash.scale = scale;

    // LOW quality: dynamic lighting is off — keep the mesh flash, skip the light.
    if (!isLowQuality()) {
      this.muzzleLight.color.setHex(color);
      this.muzzleLight.position.set(x, y + 0.2, z);
      this.muzzleLight.intensity = scale * 2.2;
      this.lightLife = MUZZLE_FLASH_LIFE;
    }
  }

  /** Spawns a small spark burst where a bullet struck a wall. */
  impact(x: number, z: number, color = 0xffe6a0, y = 0.8): void {
    // LOW quality: thin the wall-spark bursts to every other impact.
    if (isLowQuality() && this.impactTick++ % 2 === 1) return;
    const impact = this.impacts.find((candidate) => candidate.life <= 0) ?? this.impacts[0];
    impact.mesh.position.set(x, y, z);
    impact.mesh.material.color.setHex(color);
    impact.mesh.material.opacity = 0.95;
    impact.mesh.scale.setScalar(FX_CONFIG.impactScale);
    impact.mesh.visible = true;
    impact.life = FX_CONFIG.impactLife;
  }

  update(dt: number): void {
    for (const impact of this.impacts) {
      if (impact.life <= 0) continue;
      impact.life -= dt;
      if (impact.life <= 0) {
        impact.life = 0;
        impact.mesh.visible = false;
        continue;
      }
      const progress = 1 - impact.life / FX_CONFIG.impactLife;
      impact.mesh.scale.setScalar(FX_CONFIG.impactScale * (1 + progress * 1.6));
      impact.mesh.material.opacity = 0.95 * (1 - progress);
    }

    for (const tracer of this.tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= dt;
      if (tracer.life <= 0) {
        tracer.life = 0;
        tracer.line.visible = false;
        continue;
      }
      tracer.line.material.opacity = 0.9 * (tracer.life / TRACER_LIFE);
    }

    for (const flash of this.flashes) {
      if (flash.life <= 0) continue;
      flash.life -= dt;
      if (flash.life <= 0) {
        flash.life = 0;
        flash.mesh.visible = false;
        continue;
      }
      const progress = 1 - flash.life / MUZZLE_FLASH_LIFE;
      flash.mesh.scale.setScalar(flash.scale * (0.4 + progress * 1.6));
      flash.mesh.material.opacity = 0.9 * (1 - progress);
    }

    if (this.lightLife > 0) {
      this.lightLife -= dt;
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity * 0.72);
      if (this.lightLife <= 0) this.muzzleLight.intensity = 0;
    }
  }

  /** Hides every pooled effect (used on menu/restart). */
  reset(): void {
    for (const tracer of this.tracers) {
      tracer.life = 0;
      tracer.line.visible = false;
    }
    for (const flash of this.flashes) {
      flash.life = 0;
      flash.mesh.visible = false;
    }
    for (const impact of this.impacts) {
      impact.life = 0;
      impact.mesh.visible = false;
    }
    this.lightLife = 0;
    this.muzzleLight.intensity = 0;
  }
}
