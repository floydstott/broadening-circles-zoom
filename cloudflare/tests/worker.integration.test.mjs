import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.BC_WORKER_URL;

async function request(method, bodyOrQuery) {
  const response = method === 'GET'
    ? await fetch(`${baseUrl}${bodyOrQuery}`)
    : await fetch(baseUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(bodyOrQuery)
      });
  return {status: response.status, body: await response.json()};
}

async function setValue(key, value, expectedVersion = 0) {
  return request('POST', {action: 'set', key, value, expectedVersion});
}

async function resetRoom(room) {
  await request('POST', {action: 'reset_prefix', prefix: `room_${room}_`});
}

test('Cloudflare Worker/D1 synchronization contract', {skip: !baseUrl}, async (t) => {
  await Promise.all(['ABCD', 'WXYZ', 'QRST'].map(resetRoom));

  await t.test('returns CORS headers for browser preflight', async () => {
    const response = await fetch(baseUrl, {method: 'OPTIONS'});
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  });

  await t.test('rejects one of two writes against the same version', async () => {
    const key = 'room_ABCD_conflict';
    const created = await setValue(key, {winner: null});
    assert.equal(created.status, 200);
    const results = await Promise.all([
      setValue(key, {winner: 'one'}, 1),
      setValue(key, {winner: 'two'}, 1)
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(results.find((result) => result.status === 409).body.current.v, 2);
  });

  await t.test('preserves concurrent changes to different fields', async () => {
    const key = 'room_ABCD_shared';
    await setValue(key, {left: 0, right: 0});
    const results = await Promise.all([
      request('POST', {action: 'merge_field', key, path: 'left', value: 1}),
      request('POST', {action: 'merge_field', key, path: 'right', value: 2})
    ]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    const current = await request('GET', `?key=${key}`);
    assert.equal(current.body.v, 3);
    assert.deepEqual(current.body.value, {left: 1, right: 2});
  });

  await t.test('upgrades a legacy null record on its first field merge', async () => {
    const key = 'room_ABCD_legacy_dice';
    await setValue(key, null);
    const merged = await request('POST', {
      action: 'merge_fields', key,
      changes: [{path: 'rolls', value: [3]}, {path: 'used', value: [false]}]
    });
    assert.equal(merged.status, 200);
    assert.deepEqual(merged.body.record.value, {rolls: [3], used: [false]});
  });

  await t.test('rolls back every batch operation when one version conflicts', async () => {
    const firstKey = 'room_ABCD_batch_first';
    const secondKey = 'room_ABCD_batch_second';
    await setValue(firstKey, {value: 'before'});
    await setValue(secondKey, {value: 'occupied'});
    const batch = await request('POST', {
      action: 'batch',
      operations: [
        {op: 'set', key: firstKey, value: {value: 'after'}, expectedVersion: 1},
        {op: 'set', key: secondKey, value: {value: 'overwrite'}, expectedVersion: 0}
      ]
    });
    assert.equal(batch.status, 409);
    const first = await request('GET', `?key=${firstKey}`);
    assert.equal(first.body.v, 1);
    assert.deepEqual(first.body.value, {value: 'before'});
  });

  await t.test('applies a retried game move only once', async () => {
    const room = 'WXYZ';
    const prefix = `room_${room}_`;
    await setValue(`${prefix}cfg`, {
      phase: 'playing', roundPhase: 'rolling', envShown: 0,
      envDeck: [{type: 'value'}]
    });
    await setValue(`${prefix}board`, {pieces: [], nextId: 1});
    await setValue(`${prefix}dice_research`, {rolls: [2], used: [false]});
    await setValue(`${prefix}sel_research`, {outcomeColor: 'research'});
    const move = {
      action: 'apply_move', room, team: 'research', dieIndex: 0,
      move: {type: 'place', sector: 'easy', color: 'research'},
      actionId: 'act_same_move_0001'
    };
    const results = await Promise.all([request('POST', move), request('POST', move)]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    assert.equal(results.filter((result) => result.body.replayed).length, 1);
    const board = await request('GET', `?key=${prefix}board`);
    const dice = await request('GET', `?key=${prefix}dice_research`);
    assert.equal(board.body.value.pieces.length, 1);
    assert.deepEqual(dice.body.value.used, [true]);
  });

  await t.test('rejects a move after the moderator advances the phase', async () => {
    const room = 'QRST';
    const prefix = `room_${room}_`;
    await setValue(`${prefix}cfg`, {
      phase: 'playing', roundPhase: 'rolling', envShown: 0,
      envDeck: [{type: 'value'}]
    });
    await setValue(`${prefix}board`, {pieces: [], nextId: 1});
    await setValue(`${prefix}dice_research`, {rolls: [1], used: [false]});
    await setValue(`${prefix}sel_research`, {outcomeColor: 'research'});
    await request('POST', {
      action: 'merge_field', key: `${prefix}cfg`, path: 'roundPhase', value: 'idle'
    });
    const staleMove = await request('POST', {
      action: 'apply_move', room, team: 'research', dieIndex: 0,
      move: {type: 'place', sector: 'easy', color: 'research'},
      actionId: 'act_stale_move_001'
    });
    assert.equal(staleMove.status, 409);
    const board = await request('GET', `?key=${prefix}board`);
    assert.equal(board.body.value.pieces.length, 0);
  });
});
