/**
 * Deployable barricades — explosive barrels ("Barrel" slot) and wooden crates
 * ("Crate" slot).
 *
 * Both kinds occupy a full grid cell, so zombies reroute around them through
 * the flow field; a line of either forms an airtight wall. If the horde gets
 * sealed in it claws the barricade down instead. A barrel that is shot (or
 * chewed to pieces) detonates, wiping out the surrounding horde — a wooden
 * crate (150 HP, non-explosive) just splinters away and reopens its cell.
 */
import * as THREE from 'three';

import { GridMap } from '../../../shared/src/grid.ts';
import { BARREL_CONFIG, CRATE_CONFIG } from '../../../shared/src/balance.config.ts';

export type BarricadeKind = 'barrel' | 'crate';

export const BARRICADE_HP = 150; // explosive barrel durability
/** Damage a zombie deals to a barricade it is clawing through (every 0.5 s). */
export const BARRICADE_MELEE_DAMAGE = 25;
/** Radius used when testing whether a hitscan pellet struck a barricade. */
export const BARRICADE_HIT_RADIUS = 0.5;
/** Fresh-wood tint of a deployed crate (darkens toward splintered grey). */
const CRATE_COLOR = 0x9c6b3c;
/**
 * Barrel geometry is shared by every deployed barrel (one GPU buffer). The
 * material stays per-instance because it is tinted toward red as hp drops —
 * only that material is disposed when the barrel detonates.
 */
const BARREL_GEOMETRY = new THREE.CylinderGeometry(0.42, 0.42, 1.1, 12);
/**
 * Wooden crate geometry — a chunky box whose outer bounds are exactly 1.0 ×
 * 1.0, so adjacent crates sit flush with zero seams or gaps for a mob to slip
 * through. The decorative rim/panel children below stay inside those bounds.
 */
const CRATE_GEOMETRY = new THREE.BoxGeometry(1.0, 0.9, 1.0);
/** Beveled rim bars (two orientations) framing the crate's top edge. */
const CRATE_RIM_X_GEOMETRY = new THREE.BoxGeometry(1.0, 0.1, 0.08);
const CRATE_RIM_Z_GEOMETRY = new THREE.BoxGeometry(0.08, 0.1, 1.0);
/** Recessed top panel — the inset that breaks up a long line of crates. */
const CRATE_PANEL_GEOMETRY = new THREE.BoxGeometry(0.74, 0.06, 0.74);
/** Shared decorative materials: one instance each, page-lifetime like actors.ts. */
const CRATE_RIM_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xb0793f, roughness: 0.85, metalness: 0.03 });
const CRATE_PANEL_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x6f4522, roughness: 0.95, metalness: 0.02 });

/**
 * Adds the crate's decorative rim + recessed panel. These are children of the
 * crate body mesh, so a map/actor teardown removes them with the parent; their
 * shared geometry/material is never disposed (only the per-instance body
 * material is — see removeBarricade).
 */
function decorateCrate(body: THREE.Mesh): void {
  const rimY = 0.5;
  const panelY = 0.46;
  const front = new THREE.Mesh(CRATE_RIM_X_GEOMETRY, CRATE_RIM_MATERIAL);
  front.position.set(0, rimY, -0.46);
  const back = new THREE.Mesh(CRATE_RIM_X_GEOMETRY, CRATE_RIM_MATERIAL);
  back.position.set(0, rimY, 0.46);
  const left = new THREE.Mesh(CRATE_RIM_Z_GEOMETRY, CRATE_RIM_MATERIAL);
  left.position.set(-0.46, rimY, 0);
  const right = new THREE.Mesh(CRATE_RIM_Z_GEOMETRY, CRATE_RIM_MATERIAL);
  right.position.set(0.46, rimY, 0);
  const panel = new THREE.Mesh(CRATE_PANEL_GEOMETRY, CRATE_PANEL_MATERIAL);
  panel.position.set(0, panelY, 0);
  body.add(front, back, left, right, panel);
}

export interface Barricade {
  kind: BarricadeKind;
  cx: number;
  cz: number;
  hp: number;
  maxHp: number;
  mesh: THREE.Mesh;
}

export function canPlaceBarricade(grid: GridMap, cx: number, cz: number): boolean {
  return grid.inBounds(cx, cz) && !grid.isBlockedCell(cx, cz);
}

export function placeBarricade(
  grid: GridMap,
  scene: THREE.Scene,
  list: Barricade[],
  cx: number,
  cz: number,
  kind: BarricadeKind = 'barrel'
): Barricade | null {
  if (!canPlaceBarricade(grid, cx, cz)) return null;
  grid.setBlocked(cx, cz, true);

  // geometry is shared per kind; only the tint material is per-instance
  const mesh =
    kind === 'crate'
      ? new THREE.Mesh(
          CRATE_GEOMETRY,
          new THREE.MeshStandardMaterial({ color: CRATE_COLOR, roughness: 0.9, metalness: 0.05 })
        )
      : new THREE.Mesh(
          BARREL_GEOMETRY,
          new THREE.MeshStandardMaterial({ color: 0xd4551f, roughness: 0.55, metalness: 0.35 })
        );
  mesh.position.set(cx + 0.5, kind === 'crate' ? 0.45 : 0.55, cz + 0.5);
  mesh.castShadow = true;
  if (kind === 'crate') decorateCrate(mesh);
  scene.add(mesh);

  const maxHp = kind === 'crate' ? CRATE_CONFIG.hp : BARRICADE_HP;
  const barricade: Barricade = { kind, cx, cz, hp: maxHp, maxHp, mesh };
  list.push(barricade);
  return barricade;
}

export function barricadeAt(list: readonly Barricade[], cx: number, cz: number): Barricade | null {
  for (const barricade of list) {
    if (barricade.cx === cx && barricade.cz === cz) return barricade;
  }
  return null;
}

/** The explosive barrel at a cell (never a crate) — detonation paths need this. */
export function barrelAt(list: readonly Barricade[], cx: number, cz: number): Barricade | null {
  const barricade = barricadeAt(list, cx, cz);
  return barricade && barricade.kind === 'barrel' ? barricade : null;
}

/** Unblocks its cell, removes the mesh from the scene and releases GPU memory. */
export function removeBarricade(
  grid: GridMap,
  scene: THREE.Scene,
  list: Barricade[],
  barricade: Barricade
): void {
  grid.setBlocked(barricade.cx, barricade.cz, false);
  scene.remove(barricade.mesh);
  // geometry is shared; only the per-instance tint material dies
  (barricade.mesh.material as THREE.Material).dispose();
  const index = list.indexOf(barricade);
  if (index !== -1) list.splice(index, 1);
}

/** Damages a barricade; removes it when destroyed. Returns true on destruction. */
export function damageBarricade(
  grid: GridMap,
  scene: THREE.Scene,
  list: Barricade[],
  barricade: Barricade,
  damage: number
): boolean {
  barricade.hp -= damage;
  if (barricade.hp > 0) {
    const ratio = barricade.hp / barricade.maxHp;
    const material = barricade.mesh.material as THREE.MeshStandardMaterial;
    if (barricade.kind === 'crate') {
      // wood darkens toward splintered grey-brown as it takes claw damage
      material.color.setRGB(0.408 * ratio + 0.18, 0.32 * ratio + 0.1, 0.185 * ratio + 0.05);
    } else {
      // tint toward red-hot as it weakens
      material.color.setRGB(0.63 * ratio + 0.4, 0.25 * ratio + 0.1, 0.08 * ratio + 0.03);
    }
    return false;
  }
  removeBarricade(grid, scene, list, barricade);
  return true;
}

/** Cell directly in front of a point along a unit direction. */
export function cellInFront(
  grid: GridMap,
  x: number,
  z: number,
  dirX: number,
  dirZ: number
): { cx: number; cz: number } {
  return { cx: grid.cellX(x + dirX * 1.2), cz: grid.cellZ(z + dirZ * 1.2) };
}

/** True when a cell exists and nothing (wall or barricade) occupies it. */
export function isFreeCell(grid: GridMap, cx: number, cz: number): boolean {
  return grid.inBounds(cx, cz) && !grid.isBlockedCell(cx, cz);
}

/**
 * Grid-snapped barricade target: the cell directly in front of the player.
 * When that cell is already taken (wall, barrel or crate) the nearest free
 * cell is returned instead, so placement can never silently fail.
 *
 * The search expands in Chebyshev rings around the front cell and, within the
 * first ring that has any free cell, prefers the candidate best aligned with
 * the player's facing (front > sides > behind). Returns null only when every
 * cell within `placementSearchRadius` is occupied.
 */
export function findPlacementCell(
  grid: GridMap,
  x: number,
  z: number,
  dirX: number,
  dirZ: number
): { cx: number; cz: number } | null {
  const front = cellInFront(grid, x, z, dirX, dirZ);
  if (isFreeCell(grid, front.cx, front.cz)) return front;

  for (let radius = 1; radius <= BARREL_CONFIG.placementSearchRadius; radius++) {
    let best: { cx: number; cz: number } | null = null;
    let bestScore = -Infinity;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue; // ring only
        const cx = front.cx + dx;
        const cz = front.cz + dz;
        if (!isFreeCell(grid, cx, cz)) continue;
        const score = dx * dirX + dz * dirZ; // alignment with facing
        if (score > bestScore) {
          bestScore = score;
          best = { cx, cz };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Grid cell a player is currently standing on for a wooden-crate placement.
 * Returns the player's own cell when it is free; otherwise the nearest free
 * adjacent cell (Chebyshev rings around the standing cell, preferring the cell
 * closest to the player's exact position). Returns null only when the whole
 * searched neighbourhood is occupied.
 */
export function findStandingCell(
  grid: GridMap,
  x: number,
  z: number
): { cx: number; cz: number } | null {
  const cx = grid.cellX(x);
  const cz = grid.cellZ(z);
  if (isFreeCell(grid, cx, cz)) return { cx, cz };

  for (let radius = 1; radius <= BARREL_CONFIG.placementSearchRadius; radius++) {
    let best: { cx: number; cz: number } | null = null;
    let bestScore = Infinity;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue; // ring only
        const nx = cx + dx;
        const nz = cz + dz;
        if (!isFreeCell(grid, nx, nz)) continue; // walls *and* barricades block
        const score = Math.hypot(nx + 0.5 - x, nz + 0.5 - z); // nearest to the player
        if (score < bestScore) {
          bestScore = score;
          best = { cx: nx, cz: nz };
        }
      }
    }
    if (best) return best;
  }
  return null;
}
