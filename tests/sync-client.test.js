const test = require('node:test');
const assert = require('node:assert/strict');

const sync = require('../sync.js');

function resetSyncState() {
  for (const key of Object.keys(sync.SyncState.versions)) delete sync.SyncState.versions[key];
  for (const key of Object.keys(sync.SyncState.values)) delete sync.SyncState.values[key];
  for (const key of Object.keys(sync.SyncState.pending)) delete sync.SyncState.pending[key];
  global.fetch = undefined;
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test.beforeEach(resetSyncState);
test.after(resetSyncState);

test('rejects a stale record and keeps the newest cached value', () => {
  sync.syncRemember('room_TEST_cfg', {v: 5, value: {round: 4}});
  const stale = sync.syncRemember('room_TEST_cfg', {v: 4, value: {round: 3}});

  assert.equal(stale.stale, true);
  assert.equal(sync.syncVersion('room_TEST_cfg'), 5);
  assert.deepEqual(sync.syncCached('room_TEST_cfg'), {round: 4});
});

test('conditional set sends the cached version and remembers the committed version', async () => {
  sync.syncRemember('room_TEST_cfg', {v: 2, value: {round: 1}});
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return response(200, {
      ok: true,
      record: {v: 3, value: {round: 2}, updatedAt: 100}
    });
  };

  const value = await sync.sSet('room_TEST_cfg', {round: 2});

  assert.equal(requestBody.expectedVersion, 2);
  assert.deepEqual(value, {round: 2});
  assert.equal(sync.syncVersion('room_TEST_cfg'), 3);
});

test('a write conflict refreshes the cache before surfacing the error', async () => {
  sync.syncRemember('room_TEST_cfg', {v: 2, value: {round: 1}});
  global.fetch = async () => response(409, {
    conflict: true,
    key: 'room_TEST_cfg',
    current: {v: 4, value: {round: 3}, updatedAt: 120}
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(sync.sSet('room_TEST_cfg', {round: 2}), (error) => {
      assert.equal(error.status, 409);
      return true;
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(sync.syncVersion('room_TEST_cfg'), 4);
  assert.deepEqual(sync.syncCached('room_TEST_cfg'), {round: 3});
});

test('a conditional write can reapply its specific change to the winning value', async () => {
  sync.syncRemember('room_TEST_cfg', {v: 2, value: {round: 1, extraDieTo: null}});
  const requests = [];
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return response(409, {
        conflict: true,
        key: 'room_TEST_cfg',
        current: {v: 3, value: {round: 2, extraDieTo: null}, updatedAt: 130}
      });
    }
    return response(200, {
      ok: true,
      record: {v: 4, value: body.value, updatedAt: 140}
    });
  };

  const value = await sync.sSet(
    'room_TEST_cfg',
    {round: 1, extraDieTo: 'patient'},
    (fresh) => Object.assign({}, fresh, {extraDieTo: 'patient'})
  );

  assert.equal(requests[1].expectedVersion, 3);
  assert.deepEqual(requests[1].value, {round: 2, extraDieTo: 'patient'});
  assert.deepEqual(value, {round: 2, extraDieTo: 'patient'});
  assert.equal(sync.syncVersion('room_TEST_cfg'), 4);
});

test('batch writes attach expected versions only to replacement writes', async () => {
  sync.syncRemember('room_TEST_cfg', {v: 7, value: {phase: 'lobby'}});
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return response(200, {
      ok: true,
      records: {
        room_TEST_cfg: {v: 8, value: {phase: 'playing'}, updatedAt: 200},
        room_TEST_players: {v: 3, value: [{name: 'A'}], updatedAt: 200}
      }
    });
  };

  const values = await sync.sBatch([
    {op: 'set', key: 'room_TEST_cfg', value: {phase: 'playing'}},
    {op: 'append', key: 'room_TEST_players', item: {name: 'A'}}
  ]);

  assert.equal(requestBody.operations[0].expectedVersion, 7);
  assert.equal('expectedVersion' in requestBody.operations[1], false);
  assert.deepEqual(values.room_TEST_cfg, {phase: 'playing'});
  assert.equal(sync.syncVersion('room_TEST_players'), 3);
});

test('snapshot responses cannot roll cached state backward', async () => {
  sync.syncRemember('room_TEST_board', {v: 9, value: {nextId: 10}});
  global.fetch = async () => response(200, {
    records: {
      room_TEST_board: {v: 8, value: {nextId: 9}, updatedAt: 300},
      room_TEST_cfg: {v: 1, value: {phase: 'lobby'}, updatedAt: 300}
    }
  });

  const snapshot = await sync.sSnapshot('TEST');

  assert.deepEqual(snapshot.room_TEST_board, {nextId: 10});
  assert.deepEqual(snapshot.room_TEST_cfg, {phase: 'lobby'});
});

test('guard suppresses a duplicate action while the first is in flight', async () => {
  let release;
  let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = sync.guard('move', async () => {
    calls += 1;
    await blocked;
    return 'done';
  });
  const duplicate = sync.guard('move', async () => {
    calls += 1;
    return 'duplicate';
  });

  assert.equal(await duplicate, null);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, 'done');
});

test('atomic move remembers both server-authoritative records', async () => {
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return response(200, {
      ok: true,
      records: {
        room_TEST_board: {v: 4, value: {nextId: 2}, updatedAt: 400},
        room_TEST_dice_research: {v: 3, value: {rolls: [2], used: [true]}, updatedAt: 400}
      }
    });
  };

  const result = await sync.sApplyMove(
    'TEST', 'research', 0, {type: 'place', sector: 'easy', color: 'research'}, 'act_1234567890'
  );

  assert.equal(requestBody.action, 'apply_move');
  assert.equal(requestBody.actionId, 'act_1234567890');
  assert.deepEqual(result.values.room_TEST_dice_research.used, [true]);
  assert.equal(sync.syncVersion('room_TEST_board'), 4);
});
