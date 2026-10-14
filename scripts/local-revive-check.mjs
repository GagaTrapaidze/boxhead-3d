// Local 2-player revive check — drives the real client UI over CDP.
//
// Guards the *local* (offline) co-op rules that live next to the online ones:
// P1 downed while P2 lives → passive 10 s revive; both downed → Game Over.
//
// Requires the Vite client on http://localhost:5173 and a Chrome on
// --remote-debugging-port=9333:
//   node scripts/local-revive-check.mjs
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
      await sleep(200);
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

const page = await connect(CLIENT);
try {
  await page.poll(`JSON.stringify({ ready: !!globalThis.__game_shoot })`, (o) => o.ready, 'boot');

  // Start a local 2-player match and freeze the wave clock.
  await page.evaluate(
    `(async () => {
      document.querySelector('.modeBtn[data-mode="duo"]').click();
      await new Promise((r) => setTimeout(r, 150));
      const g = globalThis.__game_shoot;
      g.director.timer = 1e9;
      g.horde.zombies.length = 0;
      return true;
    })()`
  );
  const started = await page.poll(
    `JSON.stringify({ phase: globalThis.__game_shoot.phase, players: globalThis.__game_shoot.players.length })`,
    (o) => o.phase === 'playing' && o.players === 2,
    'duo start'
  );
  assert(started.players === 2, 'local 2-player match started');

  // P1 downed while P2 lives → passive revive path (10 s), no Game Over.
  await page.evaluate(`globalThis.__game_shoot.damagePlayer(0, 9999)`);
  const downed = await page.poll(
    `JSON.stringify({
      downed: globalThis.__game_shoot.players[0].downed,
      phase: globalThis.__game_shoot.phase,
    })`,
    (o) => o.downed === true,
    'P1 downed'
  );
  assert(downed.phase === 'playing', 'match continues while P2 lives');

  // The HUD card reflects the downed state on the next rendered frame.
  await page.poll(
    `JSON.stringify({ cardDowned: document.getElementById('card1').classList.contains('downed') })`,
    (o) => o.cardDowned === true,
    'downed HUD card'
  );
  assert(true, "downed player's card shows the revive state");

  const revived = await page.poll(
    `JSON.stringify({ downed: globalThis.__game_shoot.players[0].downed, hp: globalThis.__game_shoot.players[0].hp })`,
    (o) => o.downed === false,
    'passive revive',
    14000
  );
  assert(revived.hp === 100, 'passively revived at full health');

  // Both downed at once → local Game Over.
  await page.evaluate(
    `globalThis.__game_shoot.players[0].invulnTimer = 0;
     globalThis.__game_shoot.damagePlayer(0, 9999);
     globalThis.__game_shoot.damagePlayer(1, 9999)`
  );
  await page.poll(`JSON.stringify({ phase: globalThis.__game_shoot.phase })`, (o) => o.phase === 'over', 'local game over');
  assert(true, 'both players down → local Game Over');

  assert(page.errors.length === 0, `no console errors${page.errors.length ? ` (${JSON.stringify(page.errors)})` : ''}`);

  console.log('[local-revive-check] PASS');
} catch (error) {
  console.error('[local-revive-check] FAIL:', error?.message ?? error);
  if (page.errors.length) console.error('  errors:', page.errors);
  process.exitCode = 1;
} finally {
  await page.close();
}
