// Darkness / night-wave check — drives the real client UI over CDP.
//
// Guards the shared darkness band: from `GAME_CONFIG.DARKNESS_START_WAVE` (6)
// onward the arena lighting rig eases dark in every mode, waves before it stay
// bright, and the one-wave `blackout` themed event darkens even an early wave.
// `nightMode.darkness` is the eased 0..1 factor, so this verifies the smooth
// transition rather than just a boolean.
//
// Requires the Vite client on http://localhost:5173 and a Chrome on
// --remote-debugging-port=9333:
//   node scripts/darkness-check.mjs
const DEBUG = process.env.DEBUG_URL || 'http://localhost:9333';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:5173/';
const START_WAVE = Number(process.env.DARKNESS_START_WAVE || 6);
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

const probe = `JSON.stringify({
  darkness: globalThis.__game_shoot.darkness,
  active: globalThis.__game_shoot.blackout,
  wave: globalThis.__game_shoot.director.wave,
})`;

const page = await connect(CLIENT);
try {
  await page.poll(`JSON.stringify({ ready: !!globalThis.__game_shoot })`, (o) => o.ready, 'boot');

  // Start a solo match and freeze the wave clock so the director cannot advance.
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
  const started = await page.poll(
    `JSON.stringify({ phase: globalThis.__game_shoot.phase, players: globalThis.__game_shoot.players.length })`,
    (o) => o.phase === 'playing' && o.players === 1,
    'solo start'
  );
  assert(started.players === 1, 'solo match started');

  // The wave just before the darkness band stays fully lit.
  await page.evaluate(`globalThis.__game_shoot.director.wave = ${START_WAVE - 1}`);
  await sleep(1200);
  const before = await page.poll(probe, (o) => o.darkness < 0.02, 'daylight before the band');
  assert(before.active === false, `wave ${START_WAVE - 1} keeps the daylight rig`);
  assert(before.darkness < 0.02, `wave ${START_WAVE - 1} darkness factor is ~0`);

  // Crossing into the band eases the arena dark (never snapped).
  await page.evaluate(`globalThis.__game_shoot.director.wave = ${START_WAVE}`);
  const dark = await page.poll(probe, (o) => o.darkness > 0.9, 'night falls');
  assert(dark.active === true, `wave ${START_WAVE} engages the darkness rig`);
  assert(dark.darkness > 0.9, `wave ${START_WAVE} darkness factor eases to ~1`);
  assert(dark.darkness <= 1.0001, 'the darkness factor never exceeds 1');

  // It stays dark on later waves.
  await page.evaluate(`globalThis.__game_shoot.director.wave = ${START_WAVE + 4}`);
  await sleep(300);
  const later = await page.poll(probe, (o) => o.darkness > 0.9, 'darkness persists');
  assert(later.active === true, `wave ${START_WAVE + 4} stays dark`);

  // The one-wave blackout event darkens an early wave too, then clears.
  await page.evaluate(
    `globalThis.__game_shoot.director.wave = ${START_WAVE - 2};
     globalThis.__game_shoot.director.event = 'blackout';`
  );
  const event = await page.poll(probe, (o) => o.darkness > 0.9, 'blackout event');
  assert(event.active === true, 'the blackout event engages the rig on an early wave');

  await page.evaluate(`globalThis.__game_shoot.director.event = 'none'`);
  const cleared = await page.poll(probe, (o) => o.darkness < 0.02, 'daylight restored');
  assert(cleared.active === false, 'leaving the dark wave restores full daylight');

  assert(page.errors.length === 0, `no console errors${page.errors.length ? ` (${JSON.stringify(page.errors)})` : ''}`);

  console.log('[darkness-check] PASS');
} catch (error) {
  console.error('[darkness-check] FAIL:', error?.message ?? error);
  if (page.errors.length) console.error('  errors:', page.errors);
  process.exitCode = 1;
} finally {
  await page.close();
}
