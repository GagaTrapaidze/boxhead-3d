/**
 * Phase 1 world — isometric orthographic scene + textured arena built onto the
 * shared `GridMap` so visuals and collision never disagree.
 *
 * The arena is data-driven: `loadMap(world, map)` extrudes the chosen
 * `MapDefinition` (shared/src/maps.ts) into 3D geometry and rebuilds the
 * collision grid together, so swapping maps can never desync the two.
 *
 * Map coordinates: cells [0, width) × [0, height) in world units, cell (0,0) at
 * the north-west corner (x → right, z → down-screen).
 */
import * as THREE from 'three';
import { GridMap } from '../../../shared/src/grid.ts';
import { DEFAULT_MAP_ID, getMap } from '../../../shared/src/maps.ts';
import type { MapDefinition } from '../../../shared/src/maps.ts';

export const MAP_SIZE = 40; // default cells/units; the active map may override
export const CELL_SIZE = 1;
export const SINGLE_VIEW_HEIGHT = 26; // world units visible vertically

/** Height of an extruded wall block, in world units. */
const WALL_HEIGHT = 2.0;

export interface World {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.OrthographicCamera;
  grid: GridMap;
  sunLight: THREE.DirectionalLight;
  /** Ambient hemisphere fill — dimmed to near-black by blackout waves. */
  hemiLight: THREE.HemisphereLight;
  /** Opposite-side fill light — dimmed to zero by blackout waves. */
  fillLight: THREE.DirectionalLight;
  /** All map-owned meshes live here so a map swap can dispose them wholesale. */
  arena: THREE.Group;
  /** Red warning lights mounted on the perimeter spawn gates. */
  gateLights: THREE.PointLight[];
  /** Shared emissive lamp material tinted by the gate warning pulse. */
  gateLampMaterial: THREE.MeshStandardMaterial | null;
  /** Accumulator driving the gate warning pulse. */
  gatePulse: number;
}

interface SolidRect {
  x: number;
  z: number;
  w: number;
  h: number;
}

/**
 * Greedy maximal-rectangle decomposition of the solid cells, so a whole wall
 * run becomes one mesh instead of one mesh per cell (a 40×40 maze would
 * otherwise emit hundreds of draw calls).
 */
function decomposeSolid(grid: number[][], width: number, height: number): SolidRect[] {
  const used: boolean[][] = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  const rects: SolidRect[] = [];
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      if (grid[z][x] !== 1 || used[z][x]) continue;
      let w = 1;
      while (x + w < width && grid[z][x + w] === 1 && !used[z][x + w]) w++;
      let h = 1;
      extend: while (z + h < height) {
        for (let i = 0; i < w; i++) {
          if (grid[z + h][x + i] !== 1 || used[z + h][x + i]) break extend;
        }
        h++;
      }
      for (let cz = z; cz < z + h; cz++) {
        for (let cx = x; cx < x + w; cx++) used[cz][cx] = true;
      }
      rects.push({ x, z, w, h });
    }
  }
  return rects;
}

/** Checkered ground plane sized to the map. */
function buildGround(map: MapDefinition): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  const cell = 32;
  for (let y = 0; y < 512; y += cell) {
    for (let x = 0; x < 512; x += cell) {
      const isDark = (x / cell + y / cell) % 2 === 0;
      ctx.fillStyle = isDark ? '#1a2233' : '#222b3f';
      ctx.fillRect(x, y, cell, cell);
    }
  }
  ctx.strokeStyle = 'rgba(60, 80, 120, 0.3)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 512; i += cell) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9, metalness: 0.1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(map.width, map.height), material);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(map.width / 2, 0, map.height / 2);
  ground.receiveShadow = true;
  return ground;
}

/** Disposes every geometry/material the previous map owned, then empties it. */
function disposeArena(arena: THREE.Group): void {
  // Geometries (one dispose per unique geometry; repeated calls are harmless).
  arena.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
  });
  // Materials, deduped so a shared map material is only released once.
  const materials = new Set<THREE.Material>();
  arena.traverse((child) => {
    const mesh = child as THREE.Mesh;
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) materials.add(entry);
    } else if (material) {
      materials.add(material);
    }
  });
  for (const material of materials) {
    (material as THREE.MeshStandardMaterial).map?.dispose();
    material.dispose();
  }
  arena.clear();
}

/**
 * Builds the thematic perimeter spawn gates: an arched metal doorway at each
 * cardinal wall midpoint plus a red warning lamp that pulses while a wave is
 * spawning. Mob spawns themselves stay on the walkable cell just inside.
 */
function buildSpawnGates(world: World, map: MapDefinition): void {
  world.gateLights = [];
  world.gatePulse = 0;
  world.gateLampMaterial = null;
  if (map.spawnGates.length === 0) return;

  const stone = new THREE.MeshStandardMaterial({ color: 0x2c3750, roughness: 0.9, metalness: 0.2 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x69748a, roughness: 0.5, metalness: 0.7 });
  const lampMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a0d0d,
    emissive: 0xff2020,
    emissiveIntensity: 0.05,
    roughness: 0.4,
  });
  world.gateLampMaterial = lampMaterial;

  // Shared per-gate part geometries (a handful of buffers for the whole map).
  const postGeometry = new THREE.BoxGeometry(0.28, 2.7, 0.5);
  const lintelGeometry = new THREE.BoxGeometry(1.75, 0.5, 0.5);
  const lampGeometry = new THREE.BoxGeometry(0.18, 0.18, 0.18);

  for (const gate of map.spawnGates) {
    const baseX = gate.x + gate.nx * CELL_SIZE;
    const baseZ = gate.y + gate.nz * CELL_SIZE;

    const group = new THREE.Group();
    group.position.set(baseX, 0, baseZ);
    // Local +z faces inward (away from the wall).
    group.rotation.y = Math.atan2(-gate.nx, -gate.nz);

    const leftPost = new THREE.Mesh(postGeometry, stone);
    leftPost.position.set(-0.7, 1.35, -0.12);
    const rightPost = new THREE.Mesh(postGeometry, stone);
    rightPost.position.set(0.7, 1.35, -0.12);
    const lintel = new THREE.Mesh(lintelGeometry, metal);
    lintel.position.set(0, 2.5, -0.12);
    const lamp = new THREE.Mesh(lampGeometry, lampMaterial);
    lamp.position.set(0, 2.18, 0.08);

    for (const mesh of [leftPost, rightPost, lintel, lamp]) {
      mesh.castShadow = true;
      group.add(mesh);
    }

    const light = new THREE.PointLight(0xff2222, 0, 5, 2);
    light.position.set(0, 2.2, 0.2);
    group.add(light);
    world.gateLights.push(light);

    world.arena.add(group);
  }
}

/** Pulses the gate warning lamps while a wave is actively spawning. */
export function updateSpawnGateWarnings(world: World, dt: number, spawning: boolean): void {
  world.gatePulse += dt;
  const pulse = spawning ? 0.5 + 0.5 * Math.sin(world.gatePulse * 10) : 0;
  for (const light of world.gateLights) light.intensity = pulse * 2.4;
  if (world.gateLampMaterial) {
    world.gateLampMaterial.emissiveIntensity = spawning ? 0.35 + pulse * 1.5 : 0.05;
  }
}

/**
 * Rebuilds the arena for `map`: reconstructs the collision `GridMap` from the
 * tile grid and extrudes the solid cells into wall meshes. Safe to call on every
 * match start — the previous map's GPU resources are released first.
 */
export function loadMap(world: World, map: MapDefinition): void {
  disposeArena(world.arena);

  const grid = new GridMap(map.width, map.height, CELL_SIZE);
  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (map.grid[z][x] === 1) grid.setBlocked(x, z, true);
    }
  }

  world.arena.add(buildGround(map));
  buildSpawnGates(world, map);

  const coverMaterial = new THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.85, metalness: 0.1 });
  for (const rect of decomposeSolid(map.grid, map.width, map.height)) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(rect.w, WALL_HEIGHT, rect.h), coverMaterial);
    mesh.position.set(rect.x + rect.w / 2, WALL_HEIGHT / 2, rect.z + rect.h / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    world.arena.add(mesh);
  }

  world.grid = grid;
  world.camera.position.set(map.width / 2, 40, map.height / 2);
  world.camera.lookAt(map.width / 2, 0, map.height / 2);
}

export function createWorld(container: HTMLElement): World {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f1a);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  camera.position.set(MAP_SIZE / 2, 40, MAP_SIZE / 2);
  camera.up.set(0, 0, -1); // north-up: screen top = -z
  camera.lookAt(MAP_SIZE / 2, 0, MAP_SIZE / 2);

  // Hemisphere light for ambient fill
  const hemi = new THREE.HemisphereLight(0x9fb6ff, 0x1a2233, 0.6);
  scene.add(hemi);

  // Main directional light with shadows (sun)
  const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
  sun.position.set(15, 45, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 100;
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  sun.shadow.bias = -0.001;
  scene.add(sun);

  // Secondary fill light from opposite side
  const fill = new THREE.DirectionalLight(0x8888ff, 0.3);
  fill.position.set(-15, 20, -10);
  scene.add(fill);

  const arena = new THREE.Group();
  scene.add(arena);

  const world: World = {
    scene,
    renderer,
    camera,
    grid: new GridMap(MAP_SIZE, MAP_SIZE, CELL_SIZE),
    sunLight: sun,
    hemiLight: hemi,
    fillLight: fill,
    arena,
    gateLights: [],
    gateLampMaterial: null,
    gatePulse: 0,
  };
  loadMap(world, getMap(DEFAULT_MAP_ID));
  resizeWorld(world);
  return world;
}

export function resizeWorld(world: World): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  world.renderer.setSize(width, height);
  const halfHeight = SINGLE_VIEW_HEIGHT / 2;
  const halfWidth = halfHeight * (width / height);
  world.camera.left = -halfWidth;
  world.camera.right = halfWidth;
  world.camera.top = halfHeight;
  world.camera.bottom = -halfHeight;
  world.camera.updateProjectionMatrix();
}
