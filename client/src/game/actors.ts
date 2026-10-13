/**
 * Boxhead-style actors built purely from BoxGeometry composites — no external
 * model files. Every builder returns a THREE.Group positioned at ground level.
 *
 * ── Shared resource caches ──────────────────────────────────────────────────
 * Every part resolves its geometry/material from a page-lifetime cache keyed by
 * its parameters. Spawning dozens of zombies per wave, swapping weapons or
 * restarting the match therefore never allocates GPU resources and never leaks
 * them: meshes themselves are cheap JS objects the GC reclaims, while the
 * cached GPU resources live exactly once for the lifetime of the tab. Nothing
 * in this module is ever disposed — callers must only `scene.remove()` (see
 * removeZombie / updateWeaponMesh / removePickup).
 *
 * Weapons are real, distinct 3D meshes attached to the actor's hand. The hand
 * bone (a small frame at (0.18, 0.78, 0.4)) is the pivot: the held weapon and
 * the torso rotate together with `rotation.y`, so the weapon visibly follows
 * 8-way facing instantly.
 */
import * as THREE from 'three';

// ─── Cache primitives ────────────────────────────────────────────────────────

const GEOMETRY_CACHE = new Map<string, THREE.BufferGeometry>();
const MATERIAL_CACHE = new Map<string, THREE.Material>();

function cachedGeometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let geometry = GEOMETRY_CACHE.get(key);
  if (!geometry) {
    geometry = make();
    GEOMETRY_CACHE.set(key, geometry);
  }
  return geometry;
}

function cachedMaterial(key: string, make: () => THREE.Material): THREE.Material {
  let material = MATERIAL_CACHE.get(key);
  if (!material) {
    material = make();
    MATERIAL_CACHE.set(key, material);
  }
  return material;
}

/** Shared BoxGeometry for identical dimensions. */
function boxGeometry(w: number, h: number, d: number): THREE.BoxGeometry {
  return cachedGeometry(`box:${w}x${h}x${d}`, () => new THREE.BoxGeometry(w, h, d)) as THREE.BoxGeometry;
}

/** Shared cylinder geometry (barrels, tubes, canisters). */
function cylinderGeometry(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number
): THREE.CylinderGeometry {
  return cachedGeometry(
    `cyl:${radiusTop}:${radiusBottom}:${height}:${radialSegments}`,
    () => new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)
  ) as THREE.CylinderGeometry;
}

/** Shared standard material for actor parts (keyed by color + roughness). */
function partMaterial(color: number, roughness: number): THREE.MeshStandardMaterial {
  return cachedMaterial(`part:${color}:${roughness}`, () =>
    new THREE.MeshStandardMaterial({ color, roughness })
  ) as THREE.MeshStandardMaterial;
}

/** Shared standard material with custom surface parameters (metal, emissive…). */
function surfaceMaterial(
  key: string,
  params: THREE.MeshStandardMaterialParameters
): THREE.MeshStandardMaterial {
  return cachedMaterial(key, () => new THREE.MeshStandardMaterial(params)) as THREE.MeshStandardMaterial;
}

export interface CharacterDef {
  readonly name: string;
  readonly torsoColor: number;
  readonly headColor: number;
  readonly legColor: number;
  readonly skinColor: number;
  /** The weapon 'slot' color is used for a distinct uniform patch. */
  readonly uniformColor: number;
}

/** The four lore characters; P1 defaults to Bambo, P2 to Bon. */
export const CHARACTERS = {
  bambo: {
    name: 'Bambo',
    torsoColor: 0x4f8f3f, // green field uniform
    headColor: 0xd9b38c, // skin
    legColor: 0x3c6e33, // shorts
    skinColor: 0xe8c9a0,
    uniformColor: 0x2b2b2b, // dark belt/vest
  },
  bon: {
    name: 'Bon',
    torsoColor: 0x2f5fd0, // SWAT blue
    headColor: 0xc9d4e6, // skin
    legColor: 0x1b2a4a, // trousers
    skinColor: 0xd8cdf0,
    uniformColor: 0x1e3a6b, // helmet/visor band
  },
  bind: {
    name: 'Bind',
    torsoColor: 0x2b2f38, // grey trench coat
    headColor: 0xdcc4a8,
    legColor: 0x1a1d24,
    skinColor: 0xe6d5bd,
    uniformColor: 0x8b93a3, // dark sash
  },
  bert: {
    name: 'Bert',
    torsoColor: 0xb08a3e, // khaki
    headColor: 0xcba77e,
    legColor: 0x6e5a2a,
    skinColor: 0xe8d4a8,
    uniformColor: 0x3a3a3a,
  },
} as const satisfies Record<string, CharacterDef>;

export type CharacterId = keyof typeof CHARACTERS;

/** A low-poly box cast/receives shadows; face shading comes from the scene lights. */
function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  const body = new THREE.Mesh(
    boxGeometry(w, h, d),
    surfaceMaterial(`actor:${color}`, { color, roughness: 0.7, envMapIntensity: 0.35 })
  );
  body.castShadow = true;
  body.receiveShadow = true;
  return body;
}

/** Distinct head, torso, shoulder tubes and hands for a character. */
export function buildBoxhead(character: CharacterDef): THREE.Group {
  const group = new THREE.Group();

  const skin = character.skinColor;

  // legs
  const leftLeg = box(0.22, 0.4, 0.24, character.legColor);
  leftLeg.position.set(-0.15, 0.2, 0);
  const rightLeg = box(0.22, 0.4, 0.24, character.legColor);
  rightLeg.position.set(0.15, 0.2, 0);
  group.add(leftLeg, rightLeg);

  // shoulders (small barrels framing the torso)
  const shoulderMaterial = partMaterial(character.uniformColor, 0.7);
  const leftShoulder = new THREE.Mesh(boxGeometry(0.16, 0.18, 0.16), shoulderMaterial);
  leftShoulder.position.set(-0.32, 0.82, 0);
  const rightShoulder = new THREE.Mesh(boxGeometry(0.16, 0.18, 0.16), shoulderMaterial);
  rightShoulder.position.set(0.32, 0.82, 0);
  group.add(leftShoulder, rightShoulder);

  // torso with a contrasting vest/uniform plate
  const torso = new THREE.Mesh(
    boxGeometry(0.64, 0.66, 0.38),
    partMaterial(character.torsoColor, 0.75)
  );
  torso.position.y = 0.69;
  // vest belt line
  const belt = new THREE.Mesh(
    boxGeometry(0.6, 0.08, 0.18),
    partMaterial(character.uniformColor, 0.8)
  );
  belt.position.set(0, 0.64, 0);
  group.add(torso, belt);

  // head
  const head = new THREE.Mesh(boxGeometry(0.46, 0.46, 0.46), partMaterial(skin, 0.8));
  head.position.y = 1.24;
  group.add(head);

  // headband/visor detail
  const headband = new THREE.Mesh(
    boxGeometry(0.46, 0.07, 0.12),
    partMaterial(character.uniformColor, 0.8)
  );
  headband.position.set(0, 1.44, 0.2);
  group.add(headband);

  // hands
  const handMat = partMaterial(skin, 0.8);
  const leftHand = new THREE.Mesh(boxGeometry(0.12, 0.12, 0.12), handMat);
  leftHand.position.set(-0.26, 0.74, 0.3);
  const rightHand = new THREE.Mesh(boxGeometry(0.12, 0.12, 0.12), handMat);
  rightHand.position.set(0.26, 0.74, 0.3);
  group.add(leftHand, rightHand);

  // held weapon — distinct model per WeaponId, pivot at the hand
  // (weaponId is set later via updateWeaponMesh when weapon changes)
  const weapon = buildWeaponMesh(0); // default pistol
  weapon.position.set(0, 0.76, 0.4);
  group.add(weapon);

  return group;
}

/**
 * Distinct held-weapon geometry per WeaponId.
 * Weapons are positioned at the right hand pivot (0, 0, 0.4 relative to torso).
 */
export type WeaponMeshId = 'pistol' | 'uzi' | 'shotgun' | 'grenade';

export function buildWeaponMesh(weaponId: number): THREE.Group {
  const group = new THREE.Group();

  // shared metal/plastic surfaces — one instance each, reused by every weapon
  const metalDark = surfaceMaterial('wmat:metalDark', { color: 0x333333, roughness: 0.6, metalness: 0.7 });
  const metalLight = surfaceMaterial('wmat:metalLight', { color: 0x888888, roughness: 0.4, metalness: 0.8 });
  const plastic = surfaceMaterial('wmat:plastic', { color: 0x222222, roughness: 0.8 });
  const barrelMat = surfaceMaterial('wmat:barrel', { color: 0x444444, roughness: 0.5, metalness: 0.9 });

  switch (weaponId) {
    case 0: { // Pistol - compact sidearm
      // Frame
      const frame = new THREE.Mesh(boxGeometry(0.14, 0.08, 0.5), metalDark);
      frame.position.set(0, 0, 0);
      group.add(frame);
      // Grip
      const grip = new THREE.Mesh(boxGeometry(0.09, 0.14, 0.28), plastic);
      grip.position.set(0, -0.05, 0.15);
      grip.rotation.x = 0.15;
      group.add(grip);
      // Barrel
      const barrel = new THREE.Mesh(boxGeometry(0.04, 0.03, 0.35), barrelMat);
      barrel.position.set(0, 0.02, 0.28);
      group.add(barrel);
      // Sight
      const sight = new THREE.Mesh(boxGeometry(0.02, 0.02, 0.02), metalLight);
      sight.position.set(0, 0.06, 0.32);
      group.add(sight);
      break;
    }

    case 1: { // Shotgun - long double barrel
      // Stock
      const stock = new THREE.Mesh(boxGeometry(0.16, 0.06, 0.12), plastic);
      stock.position.set(0, 0.02, -0.05);
      group.add(stock);
      // Receiver
      const receiver = new THREE.Mesh(boxGeometry(0.12, 0.1, 0.15), metalDark);
      receiver.position.set(0, 0, 0.05);
      group.add(receiver);
      // Top barrel
      const barrel1 = new THREE.Mesh(boxGeometry(0.04, 0.025, 0.55), barrelMat);
      barrel1.position.set(0, 0.04, 0.3);
      group.add(barrel1);
      // Bottom barrel
      const barrel2 = new THREE.Mesh(boxGeometry(0.04, 0.025, 0.55), barrelMat);
      barrel2.position.set(0, -0.01, 0.3);
      group.add(barrel2);
      // Magazine tube
      const magTube = new THREE.Mesh(cylinderGeometry(0.04, 0.04, 0.3, 8), metalDark);
      magTube.rotation.x = Math.PI / 2;
      magTube.position.set(0, 0.02, 0.38);
      group.add(magTube);
      // Forend
      const forend = new THREE.Mesh(boxGeometry(0.08, 0.1, 0.2), plastic);
      forend.position.set(0, -0.03, 0.2);
      group.add(forend);
      break;
    }

    case 2: { // Uzi - compact SMG
      // Body
      const body = new THREE.Mesh(boxGeometry(0.12, 0.08, 0.55), metalDark);
      body.position.set(0, 0, 0);
      group.add(body);
      // Barrel (short, prominent)
      const barrel = new THREE.Mesh(boxGeometry(0.05, 0.03, 0.3), barrelMat);
      barrel.position.set(0, 0.03, 0.15);
      group.add(barrel);
      // Magazine
      const mag = new THREE.Mesh(boxGeometry(0.14, 0.18, 0.06), plastic);
      mag.position.set(0, 0.05, 0.3);
      group.add(mag);
      // Compensator
      const comp = new THREE.Mesh(boxGeometry(0.06, 0.04, 0.04), metalLight);
      comp.position.set(0, 0.04, 0.02);
      group.add(comp);
      // Handguard
      const guard = new THREE.Mesh(boxGeometry(0.1, 0.06, 0.15), metalDark);
      guard.position.set(0, 0.01, 0.22);
      group.add(guard);
      break;
    }

    case 3: { // Grenade - explosive canister
      // Body (rounded canister shape using cylinder)
      const body = new THREE.Mesh(
        cylinderGeometry(0.09, 0.09, 0.22, 12),
        surfaceMaterial('wmat:grenadeBody', {
          color: 0xcc5522,
          roughness: 0.5,
          metalness: 0.3,
          emissive: 0xff4400,
          emissiveIntensity: 0.15,
        })
      );
      body.rotation.x = Math.PI / 2;
      body.position.set(0, 0.02, 0.3);
      group.add(body);
      // Fuse
      const fuse = new THREE.Mesh(
        boxGeometry(0.025, 0.14, 0.025),
        surfaceMaterial('wmat:grenadeFuse', {
          color: 0xffaa22,
          emissive: 0xff6600,
          emissiveIntensity: 0.8,
        })
      );
      fuse.position.set(0, 0.12, 0.3);
      group.add(fuse);
      // Fuse cap
      const cap = new THREE.Mesh(
        cachedGeometry('sphere:0.025:8:8', () => new THREE.SphereGeometry(0.025, 8, 8)),
        surfaceMaterial('wmat:grenadeCap', {
          color: 0xff4400,
          emissive: 0xff2200,
          emissiveIntensity: 1.0,
        })
      );
      cap.position.set(0, 0.18, 0.3);
      group.add(cap);
      // Pine markings
      const stripeMat = partMaterial(0xffffff, 0.9);
      const stripe1 = new THREE.Mesh(boxGeometry(0.12, 0.015, 0.015), stripeMat);
      stripe1.position.set(0, 0.04, 0.3);
      group.add(stripe1);
      const stripe2 = new THREE.Mesh(boxGeometry(0.12, 0.015, 0.015), stripeMat);
      stripe2.position.set(0, -0.01, 0.3);
      group.add(stripe2);
      break;
    }
  }

  return group;
}

/** White/grey blocky body with red glowing eye dots. */
export function buildZombie(): THREE.Group {
  const group = new THREE.Group();

  const body = box(0.6, 0.8, 0.4, 0xd8dde8);
  body.position.y = 0.4;
  const head = box(0.5, 0.5, 0.5, 0xe8ecf2);
  head.position.y = 1.05;

  const eyeMaterial = surfaceMaterial('zombie:eye', {
    color: 0xff2222,
    emissive: 0xaa0000,
    emissiveIntensity: 0.9,
  });
  const leftEye = new THREE.Mesh(boxGeometry(0.09, 0.09, 0.06), eyeMaterial);
  leftEye.position.set(-0.12, 1.1, 0.26);
  const rightEye = new THREE.Mesh(boxGeometry(0.09, 0.09, 0.06), eyeMaterial);
  rightEye.position.set(0.12, 1.1, 0.26);

  group.add(body, head, leftEye, rightEye);
  return group;
}

/**
 * Updates the weapon mesh on a character to reflect the currently equipped weapon.
 * The held weapon is the child Group positioned at z > 0.3; it is detached and
 * rebuilt (shared cached resources — nothing is disposed here).
 */
export function updateWeaponMesh(character: THREE.Group, weaponId: number): void {
  // Find and remove old weapon mesh (last child Group)
  const toRemove: THREE.Object3D[] = [];
  character.children.forEach(child => {
    if (child instanceof THREE.Group && child.position.z > 0.3) {
      toRemove.push(child);
    }
  });
  for (const child of toRemove) {
    character.remove(child); // cached geometry/material — never disposed
  }

  // Add new weapon
  const weapon = buildWeaponMesh(weaponId);
  weapon.position.set(0, 0.76, 0.4);
  character.add(weapon);
}

/** Base emissive intensity of the shared zombie-eye material (see buildZombie). */
export const ZOMBIE_EYE_GLOW = 0.9;

/**
 * Dims/brightens the shared zombie-eye glow. Blackout waves drive it to 0 so
 * the horde is truly hidden until a light finds it — the material is cached
 * and shared by every zombie, so one write flips them all.
 */
export function setZombieEyeGlow(intensity: number): void {
  const eye = MATERIAL_CACHE.get('zombie:eye') as THREE.MeshStandardMaterial | undefined;
  if (eye) eye.emissiveIntensity = intensity;
}

/** Red/orange boxy boss with horns and burning eyes. */
export function buildDevil(): THREE.Group {
  const group = new THREE.Group();

  const body = box(0.9, 1.1, 0.6, 0xd93a1e);
  body.position.y = 0.55;
  const head = box(0.6, 0.55, 0.6, 0xf06a2a);
  head.position.y = 1.35;

  const horn = surfaceMaterial('devil:horn', { color: 0x2b1210, roughness: 0.6 });
  const leftHorn = new THREE.Mesh(boxGeometry(0.12, 0.3, 0.12), horn);
  leftHorn.position.set(-0.22, 1.72, 0);
  const rightHorn = new THREE.Mesh(boxGeometry(0.12, 0.3, 0.12), horn);
  rightHorn.position.set(0.22, 1.72, 0);

  const eyeMaterial = surfaceMaterial('devil:eye', {
    color: 0xffdd44,
    emissive: 0xff8800,
    emissiveIntensity: 0.8,
  });
  const leftEye = new THREE.Mesh(boxGeometry(0.12, 0.1, 0.06), eyeMaterial);
  leftEye.position.set(-0.15, 1.4, 0.31);
  const rightEye = new THREE.Mesh(boxGeometry(0.12, 0.1, 0.06), eyeMaterial);
  rightEye.position.set(0.15, 1.4, 0.31);

  group.add(body, head, leftHorn, rightHorn, leftEye, rightEye);

  // ── Phase-2 "rage" rig (dormant until the boss enrages at ≤50% HP) ──
  // A per-devil point light (max 4 devils) sells the burning state; the light
  // lives for the whole mesh lifetime and is simply driven to 0 when calm.
  const rageLight = new THREE.PointLight(0xff4a12, 0, 8, 2);
  rageLight.position.set(0, 1.35, 0);
  group.add(rageLight);
  group.userData.rageLight = rageLight;

  // A crown of emissive flame shards, revealed only while enraged.
  const flameMaterial = surfaceMaterial('devil:flame', {
    color: 0xff7a1a,
    emissive: 0xff3300,
    emissiveIntensity: 1.4,
  });
  const flames = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const shard = new THREE.Mesh(boxGeometry(0.16, 0.3, 0.16), flameMaterial);
    const angle = (i / 5) * Math.PI * 2;
    shard.position.set(Math.cos(angle) * 0.3, 1.72, Math.sin(angle) * 0.3);
    flames.add(shard);
  }
  flames.visible = false;
  group.add(flames);
  group.userData.rageFlames = flames;

  return group;
}

export type PickupKind = 'shotgun' | 'uzi' | 'grenade' | 'barrel' | 'power';

/** Distinct indicator colours so a drop is readable at a glance mid-fight. */
export const PICKUP_COLORS: Record<PickupKind, number> = {
  shotgun: 0xff4444, // red — shotgun
  uzi: 0xffd35c, // yellow — uzi
  grenade: 0x2f7d32, // dark green — grenades
  barrel: 0xff7a1a, // orange — explosive barrels
  power: 0xd78bff, // purple — POWER x2
};

/** Small colored box that bobs above the ground. */
export function buildPickup(kind: PickupKind): THREE.Group {
  const group = new THREE.Group();
  const crate = box(0.45, 0.45, 0.45, PICKUP_COLORS[kind]);
  crate.position.y = 0.35;
  crate.rotation.y = Math.PI / 4;
  group.add(crate);
  return group;
}

/** Orange glowing box used for fireballs and explosion flashes. */
export function buildFireballMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    boxGeometry(0.32, 0.32, 0.32),
    surfaceMaterial('projectile:fireball', {
      color: 0xff7722,
      emissive: 0xff4400,
      emissiveIntensity: 0.9,
    })
  );
  return mesh;
}

/**
 * Distinct thrown-canister model for grenades: an olive drum with a brass
 * safety cap so it reads separately from the devil's fireballs on screen.
 */
export function buildGrenadeMesh(): THREE.Mesh {
  const body = new THREE.Mesh(
    cylinderGeometry(0.13, 0.13, 0.26, 10),
    surfaceMaterial('projectile:grenade', {
      color: 0x4a5a34,
      roughness: 0.6,
      metalness: 0.3,
    })
  );
  body.rotation.z = -Math.PI / 2; // lay flat so its axis points along +x (travel)
  body.castShadow = true;
  const cap = new THREE.Mesh(
    boxGeometry(0.09, 0.09, 0.07),
    surfaceMaterial('projectile:grenadeCap', {
      color: 0xc8a03a,
      roughness: 0.4,
      metalness: 0.7,
    })
  );
  cap.position.z = 0.14;
  body.add(cap);
  return body;
}

/** Streamlined rocket model for the rocket launcher. */
export function buildRocketMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    cachedGeometry('caps:0.11:0.34:4:10', () => new THREE.CapsuleGeometry(0.11, 0.34, 4, 10)),
    surfaceMaterial('projectile:rocket', {
      color: 0xcccccc,
      emissive: 0xff4400,
      emissiveIntensity: 0.35,
      roughness: 0.5,
      metalness: 0.6,
    })
  );
  mesh.rotation.z = -Math.PI / 2; // axis along +x; projectiles.ts yaws it to travel
  return mesh;
}
