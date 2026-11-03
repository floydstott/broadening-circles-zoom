const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gameRoot = path.resolve(__dirname, '..');
const phpAvailable = !spawnSync('php', ['-v'], {stdio: 'ignore'}).error;

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startPhpServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sync-test-'));
  const port = 21000 + Math.floor(Math.random() * 20000);
  const baseUrl = `http://127.0.0.1:${port}/sync.php`;
  const child = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', gameRoot], {
    cwd: gameRoot,
    env: {
      ...process.env,
      BC_DB_PATH: path.join(tempDir, 'state.sqlite'),
      PHP_CLI_SERVER_WORKERS: '4'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}?key=room_NONE_cfg`);
      if (response.ok) return {child, tempDir, baseUrl, getLogs: () => logs};
    } catch {}
    await pause(50);
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  fs.rmSync(tempDir, {recursive: true, force: true});
  throw new Error(`PHP test server did not start.\n${logs}`);
}

async function request(baseUrl, method, bodyOrQuery) {
  const response = method === 'GET'
    ? await fetch(`${baseUrl}${bodyOrQuery}`)
    : await fetch(baseUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(bodyOrQuery)
      });
  return {status: response.status, body: await response.json()};
}

async function setValue(baseUrl, key, value, expectedVersion = 0) {
  return request(baseUrl, 'POST', {
    action: 'set', key, value, expectedVersion
  });
}

test('SQLite sync server concurrency contract', {skip: !phpAvailable}, async (t) => {
  const server = await startPhpServer();
  t.after(() => {
    try { process.kill(-server.child.pid, 'SIGTERM'); } catch {}
    fs.rmSync(server.tempDir, {recursive: true, force: true});
  });

  await t.test('rejects one of two writes against the same version', async () => {
    const key = 'room_ABCD_conflict';
    const created = await setValue(server.baseUrl, key, {winner: null});
    assert.equal(created.status, 200);
    assert.equal(created.body.record.v, 1);

    const results = await Promise.all([
      setValue(server.baseUrl, key, {winner: 'one'}, 1),
      setValue(server.baseUrl, key, {winner: 'two'}, 1)
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const conflict = results.find((result) => result.status === 409);
    assert.equal(conflict.body.conflict, true);
    assert.equal(conflict.body.current.v, 2);
  });

  await t.test('preserves concurrent changes to different fields', async () => {
    const key = 'room_ABCD_shared';
    assert.equal((await setValue(server.baseUrl, key, {left: 0, right: 0})).status, 200);

    const results = await Promise.all([
      request(server.baseUrl, 'POST', {action: 'merge_field', key, path: 'left', value: 1}),
      request(server.baseUrl, 'POST', {action: 'merge_field', key, path: 'right', value: 2})
    ]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);

    const current = await request(server.baseUrl, 'GET', `?key=${encodeURIComponent(key)}`);
    assert.equal(current.body.v, 3);
    assert.deepEqual(current.body.value, {left: 1, right: 2});
  });

  await t.test('upgrades a legacy null record on its first field merge', async () => {
    const key = 'room_ABCD_legacy_dice';
    assert.equal((await setValue(server.baseUrl, key, null)).status, 200);
    const merged = await request(server.baseUrl, 'POST', {
      action: 'merge_fields', key,
      changes: [{path: 'rolls', value: [3]}, {path: 'used', value: [false]}]
    });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.record.v, 2);
    assert.deepEqual(merged.body.record.value, {rolls: [3], used: [false]});
  });

  await t.test('rolls back every batch operation when one version conflicts', async () => {
    const firstKey = 'room_ABCD_batch_first';
    const secondKey = 'room_ABCD_batch_second';
    await setValue(server.baseUrl, firstKey, {value: 'before'});
    await setValue(server.baseUrl, secondKey, {value: 'occupied'});

    const batch = await request(server.baseUrl, 'POST', {
      action: 'batch',
      operations: [
        {op: 'set', key: firstKey, value: {value: 'after'}, expectedVersion: 1},
        {op: 'set', key: secondKey, value: {value: 'overwrite'}, expectedVersion: 0}
      ]
    });
    assert.equal(batch.status, 409);

    const first = await request(server.baseUrl, 'GET', `?key=${firstKey}`);
    assert.equal(first.body.v, 1);
    assert.deepEqual(first.body.value, {value: 'before'});
  });

  await t.test('applies a retried game move only once', async () => {
    const room = 'WXYZ';
    const prefix = `room_${room}_`;
    const cfg = {
      phase: 'playing', roundPhase: 'rolling', envShown: 0,
      envDeck: [{type: 'value'}]
    };
    await setValue(server.baseUrl, `${prefix}cfg`, cfg);
    await setValue(server.baseUrl, `${prefix}board`, {pieces: [], nextId: 1});
    await setValue(server.baseUrl, `${prefix}dice_research`, {rolls: [2], used: [false]});
    await setValue(server.baseUrl, `${prefix}sel_research`, {outcomeColor: 'research'});

    const move = {
      action: 'apply_move', room, team: 'research', dieIndex: 0,
      move: {type: 'place', sector: 'easy', color: 'research'},
      actionId: 'act_same_move_0001'
    };
    const results = await Promise.all([
      request(server.baseUrl, 'POST', move),
      request(server.baseUrl, 'POST', move)
    ]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    assert.equal(results.filter((result) => result.body.replayed).length, 1);

    const board = await request(server.baseUrl, 'GET', `?key=${prefix}board`);
    const dice = await request(server.baseUrl, 'GET', `?key=${prefix}dice_research`);
    assert.equal(board.body.value.pieces.length, 1);
    assert.deepEqual(dice.body.value.used, [true]);
  });

  await t.test('rejects a stale move after the moderator advances the phase', async () => {
    const room = 'QRST';
    const prefix = `room_${room}_`;
    await setValue(server.baseUrl, `${prefix}cfg`, {
      phase: 'playing', roundPhase: 'rolling', envShown: 0,
      envDeck: [{type: 'value'}]
    });
    await setValue(server.baseUrl, `${prefix}board`, {pieces: [], nextId: 1});
    await setValue(server.baseUrl, `${prefix}dice_research`, {rolls: [1], used: [false]});
    await setValue(server.baseUrl, `${prefix}sel_research`, {outcomeColor: 'research'});

    const advanced = await request(server.baseUrl, 'POST', {
      action: 'merge_field', key: `${prefix}cfg`, path: 'roundPhase', value: 'idle'
    });
    assert.equal(advanced.status, 200);
    const staleMove = await request(server.baseUrl, 'POST', {
      action: 'apply_move', room, team: 'research', dieIndex: 0,
      move: {type: 'place', sector: 'easy', color: 'research'},
      actionId: 'act_stale_move_001'
    });
    assert.equal(staleMove.status, 409);

    const board = await request(server.baseUrl, 'GET', `?key=${prefix}board`);
    const dice = await request(server.baseUrl, 'GET', `?key=${prefix}dice_research`);
    assert.equal(board.body.value.pieces.length, 0);
    assert.deepEqual(dice.body.value.used, [false]);
  });
});
