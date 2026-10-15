// Black Devil browser check — drives the real offline client over CDP.
// Covers: the boss spawns as a distinct black mesh, the dedicated top-centre
// BLACK DEVIL health bar tracks its HP, the shockwave deals flat damage inside
// 3 u, the laser telegraphs then channels, and the death pops a 3–4 loot
// explosion.
//
// Requires `npm run dev:client` (:5173) and a Chrome with
// --remote-debugging-port=9333.
//   node scripts/black-devil-browser-check.mjs
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
    await fetch(`${DEBUG}/json/close/${target.id}`).catch(() => {});
  }
}

const SCENARIO = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });

  // Start a single-player match on the default arena.
  document.querySelector('.modeBtn[data-mode="single"]').click();
  await sleep(250);
  const out = { phase: g.phase };

  const player = g.players[0];
  const px = player.x;
  const pz = player.z;

  // Inject the boss 2.5 u away so the shockwave trigger is in range.
  g.spawnZombie('blackDevil', px + 2.5, pz);
  await sleep(300);

  const boss = g.boss;
  out.bossSpawned = !!boss;
  out.bossMaxHp = boss ? boss.maxHp : 0;
  out.barVisible = !document.getElementById('bossBar').hidden;
  out.barName = document.getElementById('bossName').textContent;
  out.barWidth = document.getElementById('bossFill').style.width;
  out.hordeKinds = [...new Set(g.horde.zombies.map((z) => z.kind))];

  const brute = g.horde.zombies.find((z) => z.kind === 'blackDevil');

  // Shockwave (Attack 2): isolate it by disabling the spinner and the laser,
  // then stand inside 3 u — the flat 25 damage must land within a second.
  brute.laserCooldown = 999;
  brute.fireCooldown = 999;
  brute.shockCooldown = 0;
  player.x = brute.x - 2.5;
  player.z = brute.z;
  player.hp = 100; // reset *before* the next frame so the pulse is observed
  let shockHp = 100;
  for (let i = 0; i < 12; i++) {
    await sleep(60);
    if (player.hp < 100) { shockHp = player.hp; break; }
    player.hp = 100;
  }
  out.shockwaveDamaged = shockHp < 100;
  out.shockwaveHpLost = 100 - shockHp;

  // Solo immunity: the shockwave still deals its flat damage, but a single
  // player match must never apply the curse (and never light the circle).
  await sleep(200);
  out.soloCursed = player.cursed === true || !!player.curse;
  out.soloCurseLabelShown = [
    ...document.querySelectorAll('#curseLabels .curseLabel'),
  ].some((el) => !el.hidden);

  // Laser (Attack 3): isolate it and watch the telegraph resolve into the beam.
  brute.shockCooldown = 999;
  brute.fireCooldown = 999;
  brute.laserCooldown = 0;
  brute.attackState = 'idle';
  player.x = brute.x - 8;
  player.z = brute.z;
  let sawCharge = false;
  let sawFire = false;
  for (let i = 0; i < 140; i++) {
    await sleep(60);
    player.hp = 100; // stay alive through the channel
    const b = g.boss;
    if (!b) break;
    if (b.attackState === 'charge') sawCharge = true;
    if (b.attackState === 'fire') { sawFire = true; break; }
  }
  out.sawLaserTelegraph = sawCharge;
  out.sawLaserBeam = sawFire;

  // Laser occlusion: drop a wooden crate on the beam path mid-channel — the
  // continuous raycast must clamp laserLength short of the target.
  if (sawFire) {
    const midX = Math.floor((brute.x + player.x) / 2);
    const midZ = Math.floor(brute.z);
    g.placeCrate(midX, midZ);
    await sleep(160);
    out.laserLengthAfterCover = brute.laserLength;
    out.laserTargetDistance = Math.hypot(player.x - brute.x, player.z - brute.z);
    out.laserClamped = brute.laserLength < out.laserTargetDistance - 0.5;
  }

  // Spinner (Attack 1): isolate it and confirm a 4-cube ring projectile flies.
  brute.attackState = 'idle';
  brute.laserCooldown = 999;
  brute.shockCooldown = 999;
  brute.fireCooldown = 0;
  // Offset in z as well as x: the crate dropped for the laser-occlusion check
  // sits on the boss's z axis and must not block the spinner's line of sight.
  player.x = brute.x - 7;
  player.z = brute.z + 5;
  let spinner = null;
  let spinBefore = 0;
  let spinAfter = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(50);
    spinner = g.projectiles.find((p) => p.kind === 'spinner');
    if (spinner) break;
  }
  if (spinner) {
    out.spinnerCubes = spinner.mesh.children.length;
    spinBefore = spinner.spin;
    await sleep(120);
    spinAfter = g.projectiles.find((p) => p.kind === 'spinner') ? spinner.spin : spinBefore;
  }
  out.spinnerFired = !!spinner;
  out.spinnerOrbitAdvanced = spinAfter > spinBefore;

  // Loot explosion: kill the boss and count the reward cubes it drops.
  const index = g.horde.zombies.findIndex((z) => z.kind === 'blackDevil');
  const dropsBefore = g.pickups.length;
  if (index >= 0) g.damageZombie(index, 100000, 0);
  await sleep(120);
  out.bossGone = g.boss === null;
  out.barHiddenAfterKill = document.getElementById('bossBar').hidden;
  out.lootDropped = g.pickups.length - dropsBefore;

  return JSON.stringify(out);
})()`;

// Co-op (duo) check — drives the real offline client with two local players to
// prove the curse still works in co-op, is exclusive, and is suppressed by the
// respawn / revive immunity window.
const DUO_SCENARIO = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const g = globalThis.__game_shoot;
  if (!g) return JSON.stringify({ error: 'debug handle missing' });

  document.querySelector('.modeBtn[data-mode="duo"]').click();
  await sleep(350);
  const out = { phase: g.phase, mode: g.mode, playerCount: g.players.length };
  const p1 = g.players[0];
  const p2 = g.players[1];
  if (!p1 || !p2) return JSON.stringify({ ...out, error: 'duo mode did not create two players' });

  // Inject the boss on top of p1, then park p2 far away.
  g.spawnZombie('blackDevil', p1.x + 2.5, p1.z);
  await sleep(300);
  const brute = g.horde.zombies.find((z) => z.kind === 'blackDevil');
  if (!brute) return JSON.stringify({ ...out, error: 'the Black Devil did not spawn' });
  brute.laserCooldown = 999;
  brute.fireCooldown = 999;
  brute.shockCooldown = 0;

  p1.x = brute.x - 2.5;
  p1.z = brute.z;
  p2.x = brute.x + 25;
  p2.z = brute.z;
  p1.hp = 100;
  p2.hp = 100;

  // Co-op curse: the struck player is flagged and the 2 u cleanse circle shows.
  let cursed = false;
  for (let i = 0; i < 40; i++) {
    await sleep(60);
    p1.hp = 100;
    p2.hp = 100;
    if (p1.cursed || p1.curse) { cursed = true; break; }
  }
  out.duoCurseActive = cursed;
  out.duoCurseLabelShown = [
    ...document.querySelectorAll('#curseLabels .curseLabel'),
  ].some((el) => !el.hidden);

  // Respawn / revive window: down p2, force fresh rings, and confirm p1 cannot
  // be cursed while a teammate is down.
  p1.curse = null;
  p1.cursed = false;
  g.damagePlayer(1, 1000);
  await sleep(100);
  out.teammateDowned = p2.alive === false;
  let cursedDuringWindow = false;
  for (let i = 0; i < 25; i++) {
    await sleep(60);
    p1.hp = 100;
    brute.shockCooldown = 0;
    if (p1.cursed) { cursedDuringWindow = true; break; }
  }
  out.curseDuringRespawnWindow = cursedDuringWindow;

  return JSON.stringify(out);
})()`;

function fail(message) {
  console.error(`\u2717 ${message}`);
  process.exitCode = 1;
}

const solo = await withPage(async (evaluate) => {
  const raw = await evaluate(SCENARIO);
  return JSON.parse(raw);
});
const duo = await withPage(async (evaluate) => {
  const raw = await evaluate(DUO_SCENARIO);
  return JSON.parse(raw);
});
const value = solo.value;
const consoleErrors = [...solo.consoleErrors, ...duo.consoleErrors];

console.log('solo:', JSON.stringify(value, null, 2));
console.log('duo:', JSON.stringify(duo.value, null, 2));

if (value.error) fail(value.error);
else {
  if (value.phase !== 'playing') fail('single-player match did not start');
  if (!value.bossSpawned) fail('the Black Devil did not spawn');
  if (value.bossMaxHp !== 1200) fail(`boss max HP is ${value.bossMaxHp}, expected 1200`);
  if (!value.hordeKinds.includes('blackDevil')) fail('blackDevil missing from the horde');
  if (!value.barVisible) fail('the BLACK DEVIL health bar is hidden');
  if (value.barName !== 'BLACK DEVIL') fail(`boss bar label "${value.barName}"`);
  if (value.shockwaveDamaged !== true) fail('the shockwave never damaged the player inside 3 u');
  if (value.shockwaveHpLost < 25) fail(`shockwave dealt ${value.shockwaveHpLost}, expected its flat 25`);
  if (value.soloCursed === true) fail('a solo shockwave must not apply the curse');
  if (value.soloCurseLabelShown === true) fail('a solo match must not show the curse indicator');
  if (!value.sawLaserTelegraph) fail('the laser never entered its telegraph phase');
  if (!value.sawLaserBeam) fail('the laser never entered its beam phase');
  if (value.laserClamped !== true) {
    fail(
      'the laser was not clamped by cover (' +
        value.laserLengthAfterCover +
        ' vs target ' +
        value.laserTargetDistance +
        ')'
    );
  }
  if (value.spinnerFired !== true) fail('the spinner projectile never fired');
  if (value.spinnerCubes !== 5) {
    fail(`spinner mesh has ${value.spinnerCubes} parts, expected 1 core + 4 cubes`);
  }
  if (value.spinnerOrbitAdvanced !== true) fail('the spinner orbit animation is frozen');
  if (value.bossGone !== true) fail('the boss survived lethal damage');
  if (value.barHiddenAfterKill !== true) fail('the boss bar stayed up after the kill');
  if (value.lootDropped < 3 || value.lootDropped > 4) {
    fail(`loot explosion dropped ${value.lootDropped} cubes, expected 3-4`);
  }
}

const d = duo.value;
if (d.error) fail(d.error);
else {
  if (d.phase !== 'playing') fail('duo match did not start');
  if (d.mode !== 'duo') fail(`mode is ${d.mode}, expected duo`);
  if (d.playerCount !== 2) fail(`duo has ${d.playerCount} players, expected 2`);
  if (d.duoCurseActive !== true) fail('the co-op shockwave did not apply the curse');
  if (d.duoCurseLabelShown !== true) fail('the co-op cleanse circle is not shown');
  if (d.teammateDowned !== true) fail('the teammate was not downed for the respawn-window check');
  if (d.curseDuringRespawnWindow === true) {
    fail('a curse was applied while a teammate was respawning');
  }
}

if (consoleErrors.length > 0) fail(`console errors: ${consoleErrors.join(' | ')}`);

if (process.exitCode) console.error('\nBLACK DEVIL BROWSER CHECK FAILED');
else console.log('\nBLACK DEVIL BROWSER CHECK PASSED');
