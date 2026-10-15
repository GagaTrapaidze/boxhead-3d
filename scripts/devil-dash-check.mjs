// Red Devil phase-2 charge check — drives the real client UI over CDP.
//
// The bug: the enraged Red Devil locked onto its initial dash heading and flew
// straight past the player, blind. This guards the fix on the *offline* path
// (the server authority is covered by shared/test/devilDash.test.ts): a charge
// committed perpendicular to the player must steer its heading toward the live
// player instead of holding the frozen vector.
//
// Requires the Vite client on http://localhost:5173 and a Chrome on
// --remote-debugging-port=9333:
//   node scripts/devil-dash-check.mjs
const DEBUG = process.env.DEBUG_URL || 'http://localhost:9333';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:5173/';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(url) {
  const res = await fetch(`${DEBUG}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`target creation failed: ${res.status}`);
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const errors = [];

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
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      errors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(`EXCEPTION: ${message.params.exceptionDetails.text}`);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.bringToFront');

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };

  const poll = async (expression, ok, label, timeoutMs = 12000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      const raw = await evaluate(expression);
      last = raw ? JSON.parse(raw) : null;
      if (last && ok(last)) return last;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
  };

  const close = async () => {
    try {
      ws.close();
    } catch {}
    await fetch(`${DEBUG}/json/close/${target.id}`).catch(() => {});
  };

  return { evaluate, poll, errors, close };
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok — ${message}`);
}

/** Spawns a charging Red Devil and returns the heading error (radians). */
const SETUP = `(() => {
  const g = globalThis.__game_shoot;
  const p = g.players[0];
  // Spawn the Devil beside the player and commit its charge PERPENDICULAR to
  // the player — exactly the frozen-vector case that used to fly past.
  g.spawnZombie('devil', p.x + 3, p.z);
  const devil = g.horde.zombies[g.horde.zombies.length - 1];
  devil.phase2 = true;
  devil.dashState = 'dash';
  devil.dashDirX = 0;
  devil.dashDirZ = 1; // +z, while the player sits at -x
  devil.dashTimer = 100; // hold the charge open for the observation window
  devil.hazTimer = 1e9;
  // Slow the charge so its turn is measured cleanly: at full dash speed a very
  // close target changes bearing faster than the turn rate (the Devil orbits —
  // intended), which would mask the heading rotation this check is about.
  devil.speed = 0.2;
  const toX = p.x - devil.x;
  const toZ = p.z - devil.z;
  const desired = Math.atan2(toX, toZ);
  let delta = desired - Math.atan2(devil.dashDirX, devil.dashDirZ);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return JSON.stringify({ errorBefore: Math.abs(delta), desired, index: g.horde.zombies.length - 1 });
})()`;

/** Current heading error of that Devil toward its target, in radians. */
const PROBE = `(() => {
  const g = globalThis.__game_shoot;
  const p = g.players[0];
  const devil = g.horde.zombies[g.horde.zombies.length - 1];
  if (!devil) return JSON.stringify({ gone: true });
  const desired = Math.atan2(p.x - devil.x, p.z - devil.z);
  let delta = desired - Math.atan2(devil.dashDirX, devil.dashDirZ);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return JSON.stringify({
    error: Math.abs(delta),
    kind: devil.kind,
    phase2: devil.phase2,
    state: devil.dashState,
    dashTimer: devil.dashTimer,
    dirX: devil.dashDirX,
    dirZ: devil.dashDirZ,
    dx: devil.x - p.x,
    dz: devil.z - p.z,
  });
})()`;

const page = await connect(CLIENT);
try {
  await page.poll(`JSON.stringify({ ready: !!globalThis.__game_shoot })`, (o) => o.ready, 'boot');

  // Start a solo match and freeze the wave clock so only our Devil is live.
  await page.evaluate(
    `(async () => {
      document.querySelector('.modeBtn[data-mode="single"]').click();
      await new Promise((r) => setTimeout(r, 150));
      const g = globalThis.__game_shoot;
      g.director.timer = 1e9;
      g.horde.zombies.length = 0;
      return true;
    })()`
  );
  await page.poll(
    `JSON.stringify({ phase: globalThis.__game_shoot.phase, players: globalThis.__game_shoot.players.length })`,
    (o) => o.phase === 'playing' && o.players === 1,
    'solo start'
  );

  const setup = JSON.parse(await page.evaluate(SETUP));
  assert(setup.errorBefore > 1.4, `the charge starts nearly perpendicular (error ${setup.errorBefore.toFixed(2)} rad)`);

  // Let the render loop run ~0.4 s — long enough for a meaningful turn, short
  // enough that the Devil has not necessarily reached melee range yet.
  await sleep(400);
  const after = JSON.parse(await page.evaluate(PROBE));
  assert(!!after.error || after.gone, 'the Devil is still on the field');
  assert(
    after.error < setup.errorBefore - 0.4,
    `the charge steered toward the player (heading error ${setup.errorBefore.toFixed(2)} → ${after.error.toFixed(2)} rad)`
  );
  assert(
    Math.abs(after.dirZ - 1) > 0.1 || Math.abs(after.dirX) > 0.1,
    `the heading left its frozen +z vector (dir ${after.dirX.toFixed(2)}, ${after.dirZ.toFixed(2)})`
  );

  assert(page.errors.length === 0, `no console errors${page.errors.length ? ` (${JSON.stringify(page.errors)})` : ''}`);

  console.log('[devil-dash-check] PASS — the Red Devil charge homes onto the live player');
} catch (error) {
  console.error('[devil-dash-check] FAIL:', error?.message ?? error);
  if (page.errors.length) console.error('  errors:', page.errors);
  process.exitCode = 1;
} finally {
  await page.close();
}
