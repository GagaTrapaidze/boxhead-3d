// Automated gameplay check — drives the real game over CDP.
// Covers: menu → single/duo start, facing-follows-movement shooting, collision,
// waves, kills, multiplier, grenade arc+fuse, explosive barrel detonation,
// frequent weapon drops, and the wave-completion full-heal.
// Controls: keyboard-only, matched on event.code — zero-conflict duo bindings
// (P1: Arrows + Slash/Enter + ,/. · P2: WASD + Space + Q/E) and the co-op
// 10-second downed/revive loop with a Pistol-only inventory reset.
// Requires `npm run dev:client` (:5173) and a Chrome with
// --remote-debugging-port=9333.
//   node scripts/gameplay-check.mjs
const DEBUG = 'http://localhost:9333';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withPage(fn) {
  const targetRes = await fetch(`${DEBUG}/json/new?${encodeURIComponent('http://localhost:5173/')}`, {
    method: 'PUT',
  });
  if (!targetRes.ok) throw new Error(`target creation failed: ${targetRes.status}`);
  const target = await targetRes.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    } else if (message.method === 'Runtime.consoleAPICalled') {
      if (message.params.type === 'error') {
        consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    } else if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(`EXCEPTION: ${message.params.exceptionDetails.text}`);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(2500);

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  };

  try {
    const value = await fn(evaluate, consoleErrors);
    return { value, consoleErrors };
  } finally {
    ws.close();
    // close the tab so targets don't pile up and get rAF-throttled
    await fetch(`${DEBUG}/json/close/${target.id}`).catch(() => {});
  }
}

// Shared helpers injected into every scenario (keyboard-only input).
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const down = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  const up = (code) => window.dispatchEvent(new KeyboardEvent('keyup', { code }));
  const hold = async (code, ms) => { down(code); await sleep(ms); up(code); };
  const banner = () => document.getElementById('message').textContent;
  const startSingle = async () => {
    document.querySelector('.modeBtn[data-mode="single"]').click();
    await sleep(150);
  };
`;

const SINGLE_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = { phaseAtLoad: g.phase };

  // menu controls guide: exact bindings + active-layout highlighting
  out.controlsGuide = [...document.querySelectorAll('.controls li')]
    .map((li) => li.textContent.trim())
    .join(' | ');
  out.menuSoloActive = document.getElementById('ctrlSingle').classList.contains('active');
  document.querySelector('.modeBtn[data-mode="duo"]').dispatchEvent(new MouseEvent('mouseenter'));
  out.menuDuoActivatesP1 = document.getElementById('ctrlP1').classList.contains('active');
  out.menuDuoActivatesP2 = document.getElementById('ctrlP2').classList.contains('active');
  out.menuDuoDeactivatesSolo = !document.getElementById('ctrlSingle').classList.contains('active');
  document.querySelector('.modeBtn[data-mode="single"]').dispatchEvent(new MouseEvent('mouseenter'));
  out.menuBackToSolo = document.getElementById('ctrlSingle').classList.contains('active') &&
    !document.getElementById('ctrlP1').classList.contains('active') &&
    !document.getElementById('ctrlP2').classList.contains('active');

  await startSingle();
  out.phase = g.phase;
  out.players = g.players.length;
  out.overlayHidden = document.getElementById('overlay').hidden;
  out.hudVisible = !document.getElementById('hud').hidden;
  out.character = g.players[0].character;
  out.start = { x: +g.players[0].x.toFixed(2), z: +g.players[0].z.toFixed(2) };

  // weapon cycling before any drops: only the pistol is available
  await hold('KeyQ', 50);
  out.weaponAfterCycle = document.getElementById('weapon').textContent;

  // the player starts facing east (aimX = 1) — kill a zombie dropped in front
  g.spawnZombie('walker', g.players[0].x + 4, g.players[0].z);
  await sleep(50);
  await hold('Space', 1600);
  out.score = g.score;
  out.multAfterKill = g.players[0].mult;
  out.ammoText = document.getElementById('ammo').textContent;

  // wall collision: the cell north of spawn is blocked
  const beforeW = { x: g.players[0].x, z: g.players[0].z };
  await hold('KeyW', 600);
  out.afterW = { x: +g.players[0].x.toFixed(2), z: +g.players[0].z.toFixed(2) };
  out.blockedNorth = out.afterW.z >= beforeW.z - 0.6;

  // free movement east + facing follows movement
  const beforeD = g.players[0].x;
  await hold('KeyD', 600);
  out.afterD = { x: +g.players[0].x.toFixed(2), z: +g.players[0].z.toFixed(2) };
  out.movedEast = out.afterD.x > beforeD + 1;
  out.faceEast = g.players[0].aimX > 0.5;

  // waves
  await sleep(4500);
  out.wave = g.director.wave;
  out.zombies = g.horde.zombies.length;
  out.hud = {
    score: document.getElementById('score').textContent,
    wave: document.getElementById('wave').textContent,
    weapon: document.getElementById('weapon').textContent,
  };
  out.finalPhase = g.phase;
  return JSON.stringify(out);
})()`;

const DUO_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  document.querySelector('.modeBtn[data-mode="duo"]').click();
  await sleep(150);
  out.phase = g.phase;
  out.players = g.players.map((p) => ({ id: p.index, char: p.character, x: +p.x.toFixed(1), z: +p.z.toFixed(1) }));
  out.hp2Visible = !document.getElementById('hp2row').hidden;
  g.director.timer = 1e9; // freeze the wave clock: this scenario checks input, not combat
  g.horde.zombies.length = 0;

  const p1Start = { x: g.players[0].x, z: g.players[0].z };
  const p2Start = { x: g.players[1].x, z: g.players[1].z };

  // P1 north (blocked near spawn), P2 south (open) — opposite keyboard schemes
  down('ArrowUp');
  down('KeyS');
  await sleep(1500);
  up('ArrowUp');
  up('KeyS');
  out.p1MovedTo = { x: +g.players[0].x.toFixed(1), z: +g.players[0].z.toFixed(1) };
  out.p2MovedTo = { x: +g.players[1].x.toFixed(1), z: +g.players[1].z.toFixed(1) };
  out.p1BlockedNorth = out.p1MovedTo.z >= p1Start.z - 0.6;
  out.p2MovedSouth = out.p2MovedTo.z > p2Start.z + 5;

  // squad bounding-box camera must zoom out to fit the vertical spread
  await sleep(600);
  out.cameraZoomedOut = g.world.camera.top > 13.5;

  // ZERO-CONFLICT KEY SEPARATION: in duo mode Space belongs to P2 only
  await hold('Space', 400);
  out.p2FiredFromSpace = g.players[1].lastFireMs > 0;
  out.p1SilentOnSpace = !(g.players[0].lastFireMs > 0);

  // P1 shoots with Slash, then Enter — both must register
  await hold('Slash', 400);
  out.p1FiredFromSlash = g.players[0].lastFireMs > 0;
  const p1AfterSlash = g.players[0].lastFireMs;
  await hold('Enter', 400);
  out.p1FiredFromEnter = g.players[0].lastFireMs !== p1AfterSlash;

  // independent weapon cycling: ',' cycles P1 only, 'Q' cycles P2 only
  g.players[0].granted.add(1); g.players[0].ammo.set(1, 5);
  g.players[1].granted.add(2); g.players[1].ammo.set(2, 10);
  g.players[0].weapon = 0; g.players[1].weapon = 0;
  await hold('Comma', 80);
  out.p1Cycled = g.players[0].weapon;   // pistol → shotgun
  out.p2UntouchedByComma = g.players[1].weapon === 0;
  await hold('KeyQ', 80);
  out.p2Cycled = g.players[1].weapon;   // pistol → uzi
  out.p1UntouchedByKeyQ = g.players[0].weapon === 1;

  // simultaneous everything: both move, both fire, both swap on one keyboard
  const p1X = g.players[0].x;
  const p2X = g.players[1].x;
  g.players[0].lastFireMs = -Infinity;
  g.players[1].lastFireMs = -Infinity;
  for (const code of ['ArrowRight', 'KeyD', 'Slash', 'Space', 'Period', 'KeyE']) down(code);
  await sleep(450);
  for (const code of ['ArrowRight', 'KeyD', 'Slash', 'Space', 'Period', 'KeyE']) up(code);
  await sleep(80);
  out.bothMovedEast = g.players[0].x > p1X && g.players[1].x > p2X;
  out.bothFired = g.players[0].lastFireMs > 0 && g.players[1].lastFireMs > 0;
  out.bothCycled = g.players[0].weapon === 0 && g.players[1].weapon === 0;

  out.finalPhase = g.phase;
  out.hp = g.players.map((p) => p.hp);
  return JSON.stringify(out);
})()`;

// Co-op revive loop: P1 dies with P2 alive → 10 s downed ghost → auto-revive
// with 100 HP, 2 s i-frames and a Pistol-only inventory. Both dead → Game Over.
const REVIVE_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  document.querySelector('.modeBtn[data-mode="duo"]').click();
  await sleep(200);
  g.director.timer = 1e9; // deterministic: no zombies interfere with the timing
  g.horde.zombies.length = 0;
  const p1 = g.players[0];
  const p2 = g.players[1];

  // give P1 a full loadout so the inventory reset is observable
  p1.granted.add(1); p1.ammo.set(1, 12);
  p1.weapon = 1;

  // 1) P1 dies while P2 is alive → downed, NOT game over
  const downAt = performance.now();
  g.damagePlayer(0, 999);
  await sleep(80);
  out.phaseAfterDown = g.phase;
  out.p1Downed = p1.downed === true && p1.alive === false;
  const label = document.getElementById('reviveLabel');
  out.labelAtDown = label.hidden ? null : label.textContent;

  // 2) ghost effect: the death-position mesh blinks continuously
  const seen = [];
  for (let i = 0; i < 8; i++) { seen.push(String(p1.mesh.visible)); await sleep(90); }
  out.meshFlashed = new Set(seen).size > 1;

  // 3) downed: no damage, no movement, no shooting — P2 still fully armed
  g.damagePlayer(0, 10);
  out.downedTakesNoDamage = p1.hp === 0;
  const px = p1.x; const pz = p1.z;
  await hold('ArrowRight', 300);
  out.downedDidNotMove = p1.x === px && p1.z === pz;
  const p1FireBefore = p1.lastFireMs;
  await hold('Space', 400); // P2's shoot key — must NOT fire P1
  out.p1SilentWhileDowned = p1.lastFireMs === p1FireBefore;
  out.p2FiredWhileP1Down = p2.lastFireMs > 0;

  // 4) survive the full countdown → automatic revive
  for (let i = 0; i < 45 && !p1.alive; i++) await sleep(400);
  out.reviveElapsedMs = Math.round(performance.now() - downAt);
  out.p1Revived = p1.alive === true && p1.downed === false;
  out.revivedHp = p1.hp;
  out.weaponAfterRevive = p1.weapon;
  out.grantedAfterRevive = [...p1.granted];
  out.ammoAfterRevive = p1.ammo.size;
  out.invulnAfterRevive = +(p1.invulnTimer).toFixed(2);
  out.labelHiddenAfterRevive = label.hidden;

  // 5) during the 2 s i-frames the mesh fast-flashes and damage is blocked
  const fast = [];
  for (let i = 0; i < 6; i++) { fast.push(String(p1.mesh.visible)); await sleep(60); }
  out.invulnFlashedFast = new Set(fast).size > 1;
  g.damagePlayer(0, 50);
  out.invulnBlockedDamage = p1.hp === 100;
  out.invulnElapsedMs = Math.round(performance.now() - downAt);
  // once the i-frames expire the mesh must settle on visible
  for (let i = 0; i < 25 && p1.invulnTimer > 0; i++) await sleep(200);
  out.invulnExpired = p1.invulnTimer === 0;
  out.meshVisibleAfterInvuln = p1.mesh.visible === true;

  // 6) now both fall: P2 goes down, P1 dies with no living partner → Game Over
  g.damagePlayer(1, 999);
  await sleep(60);
  out.p2DownedNotOver = p2.downed === true && g.phase === 'playing';
  g.damagePlayer(0, 999);
  await sleep(120);
  out.phaseAfterBothDown = g.phase;
  return JSON.stringify(out);
})()`;

const GRENADE_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  await startSingle();
  const p = g.players[0];
  p.mult = 20;        // grenade unlocks at ×10; give it plenty of headroom
  p.comboTimer = 999; // freeze decay so the slot stays unlocked
  p.granted.add(3);
  p.ammo.set(3, 5);
  p.x = 8.5; p.z = 13.5; p.aimX = 1; p.aimZ = 0; // row 13 is a long clear corridor
  p.weapon = 3;       // Grenade

  down('Space');
  await sleep(50);
  out.recoilAfterFire = +p.recoil.toFixed(3);
  up('Space');
  await sleep(60);    // t ≈ 110 ms

  out.grenadeCount = g.projectiles.length;
  const grenade = g.projectiles[0];
  out.grenade = grenade
    ? { y: +grenade.y.toFixed(2), vy: +grenade.vy.toFixed(2), x: +grenade.x.toFixed(2) }
    : null;
  out.launchedEast = grenade ? grenade.x > p.x : false;
  out.arcs = grenade ? grenade.y > 0.4 : false;

  // fuse is 0.6 s: still in flight before it, gone after it
  await sleep(290);   // t ≈ 400 ms
  out.aliveAt400ms = g.projectiles.length;
  await sleep(400);   // t ≈ 800 ms
  out.grenadesAfterFuse = g.projectiles.length;

  // instakill: a fresh grenade wipes every walker caught in the blast
  const land = p.x + 10.8; // 18 u/s × 0.6 s of flight
  const marks = [];
  for (const dx of [-1.2, 0, 1.2]) {
    g.spawnZombie('walker', land + dx, p.z);
    const z = g.horde.zombies[g.horde.zombies.length - 1];
    z.x = land + dx; z.z = p.z;
    marks.push(z);
  }
  out.walkersBefore = marks.length;
  out.scoreBefore = g.score;
  p.weapon = 3; p.lastFireMs = -Infinity;
  await hold('Space', 60);
  await sleep(1100); // fuse + blast
  out.walkersAliveAfterBlast = marks.filter((z) => z.alive).length;
  out.scoreGained = g.score - out.scoreBefore;
  out.hp = p.hp; // the thrower stands well outside the 4 u blast
  return JSON.stringify(out);
})()`;

// Explosive barrel: deploy it, then shoot it dead with the pistol from outside
// the blast radius and confirm it wipes out the surrounding horde.
const BARREL_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  await startSingle();
  const p = g.players[0];
  p.mult = 20;
  p.comboTimer = 999;
  p.weapon = 4;       // Explosive Barrel
  p.x = 20; p.z = 20.5; p.aimX = 1; p.aimZ = 0;
  p.lastFireMs = -Infinity;

  await hold('Space', 120); // deploy onto the grid
  out.barrels = g.barricades.length;
  out.barrelBlocked = g.barricades[0]
    ? g.world.grid.isBlockedCell(g.barricades[0].cx, g.barricades[0].cz)
    : false;
  const barrel = g.barricades[0];

  // step well outside the 4.5 u blast, still lined up on the barrel
  p.x = 15.5; p.z = 20.5; p.aimX = 1; p.aimZ = 0;

  if (barrel) {
    g.spawnZombie('walker', barrel.cx + 1.0, barrel.cz + 1.0);
    g.spawnZombie('walker', barrel.cx + 1.6, barrel.cz + 0.2);
    g.spawnZombie('walker', barrel.cx + 0.4, barrel.cz - 1.2);
  }
  out.zombiesBefore = g.horde.zombies.length;
  out.hpBefore = p.hp;
  out.scoreBefore = g.score;

  p.weapon = 0; // pistol: the barrel detonates when shot
  p.lastFireMs = -Infinity;
  await sleep(120);
  await hold('Space', 150);
  await sleep(250);

  out.barrelsAfter = g.barricades.length;
  out.zombiesAfter = g.horde.zombies.length;
  out.score = g.score;
  out.hp = p.hp;
  out.finalPhase = g.phase;
  return JSON.stringify(out);
})()`;

// Frequent weapon drops: each pickup must unlock/equip its weapon and award the
// documented ammo, and a repeat pickup must top up rather than re-unlock.
const PICKUP_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  await startSingle();
  const p = g.players[0];
  out.startWeapon = p.weapon;
  out.startGranted = [...p.granted];

  const grab = async (kind) => {
    g.spawnPickup(kind, p.x, p.z);
    await sleep(220);
    return banner();
  };

  out.shotgunMsg = await grab('shotgun');
  out.shotgunGranted = p.granted.has(1);
  out.shotgunWeapon = p.weapon;
  out.shotgunAmmoFirst = p.ammo.get(1) ?? 0;

  out.shotgunRepeatMsg = await grab('shotgun');
  out.shotgunAmmoSecond = p.ammo.get(1) ?? 0;

  out.uziMsg = await grab('uzi');
  out.uziGranted = p.granted.has(2);
  out.uziAmmo = p.ammo.get(2) ?? 0;

  out.grenadeMsg = await grab('grenade');
  out.grenadeGranted = p.granted.has(3);
  out.grenadeAmmo = p.ammo.get(3) ?? 0;

  out.barrelMsg = await grab('barrel');
  out.barrelGranted = p.granted.has(4);
  out.barrelAmmo = p.ammo.get(4) ?? 0;
  out.finalWeapon = p.weapon;

  // an availability check: a granted weapon must survive a multiplier reset
  p.mult = 1;
  p.comboTimer = 999;
  await sleep(120);
  out.grantedSurvivesReset = p.weapon === 4;
  return JSON.stringify(out);
})()`;

// Wave completion restores everyone to full HP and banners it.
const WAVE_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  await startSingle();
  const p = g.players[0];
  p.hp = 42;
  out.hpBefore = p.hp;

  // force a cleared wave: director "active" with an empty horde
  g.horde.zombies.length = 0;
  g.director.phase = 'active';
  await sleep(350);

  out.hpAfter = p.hp;
  out.banner = banner();
  out.finalPhase = g.phase;
  return JSON.stringify(out);
})()`;

const SYSTEMS_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  await startSingle();
  const p = g.players[0];
  p.mult = 16;        // unlock Barrel (×16) and Mine tiers
  p.comboTimer = 999; // freeze decay for the duration of the check
  p.hp = 100;

  // 1) mine placement (facing east by default) + detonation on contact
  p.weapon = 5;
  p.lastFireMs = -Infinity;
  await hold('Space', 100);
  out.minesPlaced = g.mines.length;
  g.spawnZombie('walker', p.x + 2, p.z); // within the 1.6 u trigger radius
  for (let i = 0; i < 16 && g.mines.length > 0; i++) await sleep(100);
  out.minesRemaining = g.mines.length;
  p.x = 8; p.z = 8; // step out of the blast before the 1.2 s fuse ends
  await sleep(1400);

  // 2) barrel placement blocks its grid cell
  p.weapon = 4;
  p.lastFireMs = -Infinity;
  await hold('Space', 120);
  out.wallsPlaced = g.barricades.length;
  out.wallBlocked = g.barricades[0]
    ? g.world.grid.isBlockedCell(g.barricades[0].cx, g.barricades[0].cz)
    : false;

  out.finalPhase = g.phase;
  out.hp = p.hp;
  return JSON.stringify(out);
})()`;

// Bullets must not pass through walls: a zombie behind cover is untouchable, and
// the very same shot connects the moment that cover is removed.
const WALL_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  await startSingle();
  const p = g.players[0];
  p.mult = 20; p.comboTimer = 999;
  p.x = 10.5; p.z = 13.5; p.aimX = 1; p.aimZ = 0; // clear corridor

  const cx = g.world.grid.cellX(p.x);
  const cz = g.world.grid.cellZ(p.z);
  g.world.grid.setBlocked(cx + 2, cz, true);      // drop a wall into the line of fire
  out.wall = [cx + 2, cz];

  g.spawnZombie('walker', p.x + 4, p.z);
  const target = g.horde.zombies[g.horde.zombies.length - 1];
  target.x = p.x + 4; target.z = p.z;
  out.hpBefore = target.hp;
  out.scoreBefore = g.score;

  p.weapon = 0; p.lastFireMs = -Infinity;
  await hold('Space', 250);
  await sleep(150);
  out.shotFired = p.lastFireMs > 0;
  out.hpBlocked = target.alive ? +target.hp.toFixed(1) : 0;
  out.scoreThroughWall = g.score - out.scoreBefore;

  // remove the cover: the next shot must connect
  g.world.grid.setBlocked(cx + 2, cz, false);
  target.x = p.x + 4; target.z = p.z;
  p.lastFireMs = -Infinity;
  await hold('Space', 250);
  await sleep(150);
  out.hpOpen = target.alive ? +target.hp.toFixed(1) : 0;
  out.scoreOpen = g.score - out.scoreBefore;
  out.finalPhase = g.phase;
  return JSON.stringify(out);
})()`;

// Shotgun distance scaling: 1-shot kill inside 3 cells, 2 shots just beyond.
const SHOTGUN_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  await startSingle();
  const p = g.players[0];
  p.mult = 20; p.comboTimer = 999;
  p.granted.add(1);
  p.ammo.set(1, 30);
  p.weapon = 1;
  p.x = 10.5; p.z = 13.5; p.aimX = 1; p.aimZ = 0;
  const fire = async () => { p.lastFireMs = -Infinity; await hold('Space', 60); await sleep(60); };

  // CLOSE: 2.0 cells → a single blast must kill a 60 HP walker outright
  g.spawnZombie('walker', p.x + 2, p.z);
  const close = g.horde.zombies[g.horde.zombies.length - 1];
  close.x = p.x + 2; close.z = p.z;
  out.closeHpBefore = close.hp;
  out.closeRange = 2;
  const ammoBefore = p.ammo.get(1);
  await fire();
  out.closeKilledByOneShot = !close.alive;
  out.closeShotsFired = ammoBefore - (p.ammo.get(1) ?? 0);

  // MEDIUM: 4.0 cells → one blast must NOT kill, the second must
  g.spawnZombie('walker', p.x + 4, p.z);
  const mid = g.horde.zombies[g.horde.zombies.length - 1];
  mid.x = p.x + 4; mid.z = p.z;
  out.midRange = 4;
  out.midHpBefore = mid.hp;
  await fire();
  out.midHpAfterOne = mid.alive ? +mid.hp.toFixed(1) : 0;
  out.midAliveAfterOne = mid.alive;
  mid.x = p.x + 4; mid.z = p.z; // park it again so shot 2 also lands at 4 cells
  await fire();
  out.midKilledByTwoShots = !mid.alive;
  out.finalPhase = g.phase;
  return JSON.stringify(out);
})()`;

// Cadence: measure the real gap between consecutive shots (immune to timer
// overshoot) — the pistol is deliberately slow, the uzi sprays.
const CADENCE_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  await startSingle();
  const p = g.players[0];
  p.mult = 20; p.comboTimer = 999;
  p.x = 10.5; p.z = 13.5; p.aimX = 1; p.aimZ = 0; // open corridor: nothing in the way

  // PISTOL — time from the 1st shot to the 2nd (infinite ammo, so watch lastFireMs)
  p.weapon = 0; p.lastFireMs = -Infinity;
  down('Space');
  for (let i = 0; i < 400 && p.lastFireMs === -Infinity; i++) await sleep(20);
  const pistolShotAt = performance.now();
  const pistolFirst = p.lastFireMs;
  for (let i = 0; i < 400 && p.lastFireMs === pistolFirst; i++) await sleep(20);
  out.pistolFiredTwice = p.lastFireMs !== pistolFirst;
  out.pistolGapMs = Math.round(performance.now() - pistolShotAt);
  up('Space');

  // UZI — same measurement, counted in rounds (the magazine drains per shot)
  p.granted.add(2); p.ammo.set(2, 40); p.weapon = 2; p.lastFireMs = -Infinity;
  down('Space');
  for (let i = 0; i < 400 && p.ammo.get(2) === 40; i++) await sleep(20);
  const uziShotAt = performance.now();
  const uziFirst = p.ammo.get(2);
  for (let i = 0; i < 400 && p.ammo.get(2) === uziFirst; i++) await sleep(20);
  out.uziGapMs = Math.round(performance.now() - uziShotAt);
  out.uziRoundsUsed = 40 - (p.ammo.get(2) ?? 40);
  up('Space');
  return JSON.stringify(out);
})()`;

// Boss resilience: one grenade blast wounds the Devil, exactly two destroy it.
const DEVIL_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};

  await startSingle();
  const p = g.players[0];
  p.mult = 20; p.comboTimer = 999;
  p.x = 8.5; p.z = 13.5; p.aimX = 1; p.aimZ = 0; // row 13 clear corridor
  p.granted.add(3); p.ammo.set(3, 10);

  g.spawnZombie('devil', p.x + 10.8, p.z);   // where the throw lands (18 × 0.6 s)
  const devil = g.horde.zombies[g.horde.zombies.length - 1];
  out.isBoss = devil.kind === 'devil';
  out.hpBefore = devil.hp;

  const throwGrenade = async () => {
    p.weapon = 3; p.lastFireMs = -Infinity;
    await hold('Space', 60);
    for (let i = 0; i < 40; i++) {
      const live = g.projectiles.filter((pr) => pr.kind !== 'fireball').length;
      if (live === 0) break;
      await sleep(50);
    }
  };

  await throwGrenade();
  out.hpAfterOne = devil.hp;
  out.aliveAfterOne = devil.alive;

  if (devil.alive) { devil.x = p.x + 10.8; devil.z = p.z; } // park it for blast #2
  await throwGrenade();
  out.hpAfterTwo = devil.hp;
  out.aliveAfterTwo = devil.alive;
  out.ammoLeft = p.ammo.get(3) ?? 0;
  out.finalPhase = g.phase;
  return JSON.stringify(out);
})()`;

// Drop frequency: the effective mob-drop probability after the 0.70x reduction.
const DROPRATE_SCENARIO = `(async () => {
  ${HELPERS}
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });
  const out = {};
  await startSingle();
  out.rolls = 4000;
  out.drops = g.rollDrop(out.rolls);   // same roll the kill path calls
  out.observedRate = +(out.drops / out.rolls).toFixed(3);
  return JSON.stringify(out);
})()`;

async function main() {
  let failed = false;
  const fail = (message) => {
    console.log('FAIL:', message);
    failed = true;
  };
  const expectNoConsoleErrors = (label, errors) => {
    if (errors.length > 0) fail(`console errors in ${label}: ${JSON.stringify(errors)}`);
  };

  const single = await withPage(async (evaluate) => JSON.parse(await evaluate(SINGLE_SCENARIO)));
  console.log('SINGLE:', JSON.stringify(single.value, null, 1));
  console.log('SINGLE_CONSOLE_ERRORS:', JSON.stringify(single.consoleErrors));
  if (single.value.phase !== 'playing') fail('single mode did not start');
  if (!(single.value.score > 0)) fail('single mode did not score a kill');
  if (!(single.value.multAfterKill >= 2)) fail('multiplier did not increase after kill');
  if (single.value.weaponAfterCycle !== 'Pistol') fail('pre-drop Q-cycle should stay Pistol');
  const guide = single.value.controlsGuide ?? '';
  for (const line of [
    'Movement: WASD or Arrow Keys',
    'Shoot / Action: Spacebar',
    'Switch Weapons: [Q] / [E] or [1] - [6]',
    'Movement: Arrow Keys (↑, ↓, ←, →)',
    'Shoot / Action: [/] (Slash) or [Enter]',
    'Switch Weapons: [,] (Prev) and [.] (Next)',
    'Movement: [W], [A], [S], [D]',
    'Shoot / Action: [Space]',
    'Switch Weapons: [Q] (Prev) and [E] (Next)',
  ]) {
    if (!guide.includes(line)) fail(`controls guide missing "${line}" (got "${guide}")`);
  }
  if (!single.value.menuSoloActive) fail('menu must highlight the Solo layout by default');
  if (!single.value.menuDuoActivatesP1 || !single.value.menuDuoActivatesP2 ||
      !single.value.menuDuoDeactivatesSolo) {
    fail('switching to Local 2-Player must highlight the P1 + P2 layouts');
  }
  if (!single.value.menuBackToSolo) fail('switching back to Solo must re-highlight the single-player layout');
  if (!single.value.blockedNorth || !single.value.movedEast) fail('movement / grid collision broken');
  if (!single.value.faceEast) fail('facing did not follow the movement vector');
  if (!(single.value.wave >= 1)) fail('wave director did not start a wave');
  expectNoConsoleErrors('single mode', single.consoleErrors);

  const duo = await withPage(async (evaluate) => JSON.parse(await evaluate(DUO_SCENARIO)));
  console.log('DUO:', JSON.stringify(duo.value, null, 1));
  console.log('DUO_CONSOLE_ERRORS:', JSON.stringify(duo.consoleErrors));
  if (duo.value.players?.length !== 2) fail('duo mode did not create two players');
  if (!duo.value.p2MovedSouth) fail('P2 WASD movement broken');
  if (!duo.value.cameraZoomedOut) fail('bounding-box camera did not zoom out');
  if (!duo.value.p2FiredFromSpace) fail('P2 must fire from Space in duo mode');
  if (!duo.value.p1SilentOnSpace) fail('P1 must NOT fire from Space in duo mode (key conflict)');
  if (!duo.value.p1FiredFromSlash || !duo.value.p1FiredFromEnter) {
    fail('P1 shoot keys (Slash / Enter) are broken');
  }
  if (duo.value.p1Cycled !== 1 || duo.value.p2Cycled !== 2) {
    fail(`independent weapon cycling broken (P1 → ${duo.value.p1Cycled}, P2 → ${duo.value.p2Cycled})`);
  }
  if (!duo.value.p2UntouchedByComma || !duo.value.p1UntouchedByKeyQ) {
    fail('weapon-cycle keys leaked between the two players');
  }
  if (!duo.value.bothMovedEast || !duo.value.bothFired || !duo.value.bothCycled) {
    fail('simultaneous 2-player move+fire+swap dropped input');
  }
  expectNoConsoleErrors('duo mode', duo.consoleErrors);

  const revive = await withPage(async (evaluate) => JSON.parse(await evaluate(REVIVE_SCENARIO)));
  console.log('REVIVE:', JSON.stringify(revive.value, null, 1));
  console.log('REVIVE_CONSOLE_ERRORS:', JSON.stringify(revive.consoleErrors));
  if (revive.value.phaseAfterDown !== 'playing') fail('P1 dying with P2 alive must NOT end the game');
  if (!revive.value.p1Downed) fail('P1 did not enter the downed state');
  if (!revive.value.labelAtDown || !/REVIVING IN:\s*10s/.test(revive.value.labelAtDown)) {
    fail(`revive countdown label missing/wrong (got "${revive.value.labelAtDown}")`);
  }
  if (!revive.value.meshFlashed) fail('downed mesh did not blink at the death position');
  if (!revive.value.downedTakesNoDamage) fail('a downed player still took damage');
  if (!revive.value.downedDidNotMove) fail('a downed player still moved');
  if (!revive.value.p1SilentWhileDowned) fail('a downed player still shot');
  if (!revive.value.p2FiredWhileP1Down) fail('the survivor could not keep firing');
  if (!revive.value.p1Revived) fail('P1 did not revive after the 10 s countdown');
  if (!(revive.value.reviveElapsedMs >= 9000 && revive.value.reviveElapsedMs <= 15000)) {
    fail(`revive should take ~10 s (measured ${revive.value.reviveElapsedMs} ms)`);
  }
  if (revive.value.revivedHp !== 100) fail(`revive must restore 100 HP (got ${revive.value.revivedHp})`);
  if (revive.value.weaponAfterRevive !== 0) fail('revive must reset to the starter Pistol');
  if (revive.value.grantedAfterRevive?.length !== 0 || revive.value.ammoAfterRevive !== 0) {
    fail('revive must strip every weapon/ammo grant');
  }
  if (!(revive.value.invulnAfterRevive > 0)) fail('revive must grant invulnerability');
  if (!revive.value.invulnFlashedFast) fail('revived mesh must fast-flash during i-frames');
  if (!revive.value.invulnBlockedDamage) fail('post-revive invulnerability did not block damage');
  if (!revive.value.invulnExpired || !revive.value.meshVisibleAfterInvuln) {
    fail('mesh must settle on visible once the i-frames expire');
  }
  if (revive.value.labelHiddenAfterRevive !== true) fail('revive label must hide after revival');
  if (!revive.value.p2DownedNotOver) fail('the second player must go down without a premature game over');
  if (revive.value.phaseAfterBothDown !== 'over') fail('both players dead must trigger Game Over immediately');
  expectNoConsoleErrors('revive scenario', revive.consoleErrors);

  const grenade = await withPage(async (evaluate) => JSON.parse(await evaluate(GRENADE_SCENARIO)));
  console.log('GRENADE:', JSON.stringify(grenade.value, null, 1));
  console.log('GRENADE_CONSOLE_ERRORS:', JSON.stringify(grenade.consoleErrors));
  if (grenade.value.grenadeCount !== 1 || !grenade.value.launchedEast || !grenade.value.arcs) {
    fail('grenade did not launch as an arcing projectile');
  }
  if (grenade.value.aliveAt400ms !== 1) fail('grenade detonated before its 0.6 s fuse');
  if (grenade.value.grenadesAfterFuse !== 0) fail('grenade did not detonate after its 0.6 s fuse');
  if (grenade.value.walkersAliveAfterBlast !== 0) {
    fail(`grenade blast must instakill every walker in range (${grenade.value.walkersAliveAfterBlast} survived)`);
  }
  if (!(grenade.value.scoreGained >= 30)) fail('grenade kills did not score');
  if (!(grenade.value.recoilAfterFire > 0)) fail('firing produced no recoil kick');
  expectNoConsoleErrors('grenade scenario', grenade.consoleErrors);

  const wall = await withPage(async (evaluate) => JSON.parse(await evaluate(WALL_SCENARIO)));
  console.log('WALL:', JSON.stringify(wall.value, null, 1));
  console.log('WALL_CONSOLE_ERRORS:', JSON.stringify(wall.consoleErrors));
  if (!wall.value.shotFired) fail('wall scenario never fired a shot');
  if (wall.value.hpBlocked !== wall.value.hpBefore) {
    fail(`bullets passed through a wall (hp ${wall.value.hpBefore} → ${wall.value.hpBlocked}, score +${wall.value.scoreThroughWall})`);
  }
  if (!(wall.value.hpOpen < wall.value.hpBefore)) {
    fail('removing the wall did not let the shot connect');
  }
  expectNoConsoleErrors('wall scenario', wall.consoleErrors);

  const shotgun = await withPage(async (evaluate) => JSON.parse(await evaluate(SHOTGUN_SCENARIO)));
  console.log('SHOTGUN:', JSON.stringify(shotgun.value, null, 1));
  console.log('SHOTGUN_CONSOLE_ERRORS:', JSON.stringify(shotgun.consoleErrors));
  if (!(shotgun.value.closeShotsFired >= 1)) fail('shotgun did not fire');
  if (!shotgun.value.closeKilledByOneShot) fail('a close-range shotgun blast must one-shot a walker');
  if (shotgun.value.midAliveAfterOne !== true) fail('a single mid-range shotgun blast must not kill a full-HP walker');
  if (!shotgun.value.midKilledByTwoShots) fail('two mid-range shotgun blasts must kill a walker');
  expectNoConsoleErrors('shotgun scenario', shotgun.consoleErrors);

  const cadence = await withPage(async (evaluate) => JSON.parse(await evaluate(CADENCE_SCENARIO)));
  console.log('CADENCE:', JSON.stringify(cadence.value, null, 1));
  console.log('CADENCE_CONSOLE_ERRORS:', JSON.stringify(cadence.consoleErrors));
  if (!cadence.value.pistolFiredTwice) fail('pistol never fired a second shot');
  if (!(cadence.value.pistolGapMs >= 300 && cadence.value.pistolGapMs <= 500)) {
    fail(`pistol cadence should be ~333 ms (measured ${cadence.value.pistolGapMs} ms)`);
  }
  if (!(cadence.value.uziGapMs > 0 && cadence.value.uziGapMs <= 150)) {
    fail(`uzi cadence should be a rapid ~55 ms (measured ${cadence.value.uziGapMs} ms)`);
  }
  if (!(cadence.value.uziGapMs * 2 < cadence.value.pistolGapMs)) {
    fail(`the uzi must be far faster than the pistol (uzi ${cadence.value.uziGapMs} ms vs pistol ${cadence.value.pistolGapMs} ms)`);
  }
  expectNoConsoleErrors('cadence scenario', cadence.consoleErrors);

  const barrel = await withPage(async (evaluate) => JSON.parse(await evaluate(BARREL_SCENARIO)));
  console.log('BARREL:', JSON.stringify(barrel.value, null, 1));
  console.log('BARREL_CONSOLE_ERRORS:', JSON.stringify(barrel.consoleErrors));
  if (barrel.value.barrels !== 1 || !barrel.value.barrelBlocked) fail('barrel was not deployed / did not block its cell');
  if (barrel.value.barrelsAfter !== 0) fail('shooting the barrel did not detonate it');
  if (!(barrel.value.zombiesAfter < barrel.value.zombiesBefore)) fail('barrel blast did not wipe out nearby zombies');
  if (!(barrel.value.score > barrel.value.scoreBefore)) fail('barrel kills did not score');
  expectNoConsoleErrors('barrel scenario', barrel.consoleErrors);

  const pickup = await withPage(async (evaluate) => JSON.parse(await evaluate(PICKUP_SCENARIO)));
  console.log('PICKUP:', JSON.stringify(pickup.value, null, 1));
  console.log('PICKUP_CONSOLE_ERRORS:', JSON.stringify(pickup.consoleErrors));
  if (pickup.value.startWeapon !== 0) fail('player should start on the pistol');
  if (!pickup.value.shotgunGranted || pickup.value.shotgunWeapon !== 1) fail('shotgun pickup did not unlock+equip');
  if (!/UNLOCKED/.test(pickup.value.shotgunMsg)) fail('shotgun pickup banner did not report the unlock');
  if (pickup.value.shotgunAmmoFirst !== 30) fail(`shotgun award should be 30 (got ${pickup.value.shotgunAmmoFirst})`);
  if (pickup.value.shotgunAmmoSecond !== 60) fail(`repeat shotgun should top up to 60 (got ${pickup.value.shotgunAmmoSecond})`);
  if (/UNLOCKED/.test(pickup.value.shotgunRepeatMsg)) fail('repeat pickup should not re-report UNLOCKED');
  if (!pickup.value.uziGranted || pickup.value.uziAmmo < 150) fail('uzi pickup must unlock and award 150 rounds');
  if (!pickup.value.grenadeGranted || pickup.value.grenadeAmmo < 5) fail('grenade pickup must grant at least 5');
  if (!pickup.value.barrelGranted || pickup.value.barrelAmmo < 3) fail('barrel pickup must grant at least 3');
  if (pickup.value.finalWeapon !== 4) fail('pickup should equip the collected weapon');
  if (!pickup.value.grantedSurvivesReset) fail('pickup-granted weapon must survive a multiplier reset');
  expectNoConsoleErrors('pickup scenario', pickup.consoleErrors);

  const wave = await withPage(async (evaluate) => JSON.parse(await evaluate(WAVE_SCENARIO)));
  console.log('WAVE:', JSON.stringify(wave.value, null, 1));
  console.log('WAVE_CONSOLE_ERRORS:', JSON.stringify(wave.consoleErrors));
  if (wave.value.hpAfter !== 100) fail(`wave clear must restore full HP (got ${wave.value.hpAfter})`);
  if (!/100%\s*HP/i.test(wave.value.banner)) fail(`wave clear banner missing (got "${wave.value.banner}")`);
  expectNoConsoleErrors('wave scenario', wave.consoleErrors);

  const systems = await withPage(async (evaluate) => JSON.parse(await evaluate(SYSTEMS_SCENARIO)));
  console.log('SYSTEMS:', JSON.stringify(systems.value, null, 1));
  console.log('SYSTEMS_CONSOLE_ERRORS:', JSON.stringify(systems.consoleErrors));
  if (systems.value.minesPlaced !== 1 || systems.value.minesRemaining !== 0) fail('mine placement / detonation broken');
  if (systems.value.wallsPlaced !== 1 || !systems.value.wallBlocked) fail('barrel placement / grid blocking broken');
  expectNoConsoleErrors('systems scenario', systems.consoleErrors);

  const devil = await withPage(async (evaluate) => JSON.parse(await evaluate(DEVIL_SCENARIO)));
  console.log('DEVIL:', JSON.stringify(devil.value, null, 1));
  console.log('DEVIL_CONSOLE_ERRORS:', JSON.stringify(devil.consoleErrors));
  if (!devil.value.isBoss) fail('devil spawn was not the boss kind');
  if (!(devil.value.hpBefore > devil.value.hpAfterOne)) fail('a grenade blast did not wound the Devil');
  if (devil.value.aliveAfterOne !== true) {
    fail(`a single grenade blast must NOT kill the Devil (hp ${devil.value.hpBefore} → ${devil.value.hpAfterOne})`);
  }
  if (devil.value.aliveAfterTwo !== false || !(devil.value.hpAfterTwo <= 0)) {
    fail(`two direct grenade blasts must kill the Devil (left at ${devil.value.hpAfterTwo})`);
  }
  expectNoConsoleErrors('devil scenario', devil.consoleErrors);

  const drop = await withPage(async (evaluate) => JSON.parse(await evaluate(DROPRATE_SCENARIO)));
  console.log('DROPRATE:', JSON.stringify(drop.value, null, 1));
  console.log('DROPRATE_CONSOLE_ERRORS:', JSON.stringify(drop.consoleErrors));
  if (!(drop.value.observedRate >= 0.44 && drop.value.observedRate <= 0.54)) {
    fail(`mob drop rate should be ~0.49 (0.70 base x 0.70), observed ${drop.value.observedRate}`);
  }
  expectNoConsoleErrors('drop-rate scenario', drop.consoleErrors);

  if (failed) process.exit(1);
  console.log('ALL GAMEPLAY CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
