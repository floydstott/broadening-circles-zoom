// Cloudflare Worker/D1 implementation of the Broadening Circles sync API.
// The original PHP/SQLite backend remains available at ../../sync.php.

const KEY_RE = /^[A-Za-z0-9_-]{1,160}$/;
const ROOM_RE = /^[A-Z2-9]{4}$/;
const ACTION_RE = /^[A-Za-z0-9_-]{12,120}$/;
const TEAMS = new Set(['research', 'patient', 'balanced']);
const SECTOR_LENGTHS = {easy: 9, medium: 13, hard: 20};

class HttpError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function nowMs() {
  return Date.now();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function jsonHeaders(request, env) {
  const configured = env.ALLOWED_ORIGIN || '*';
  const origin = request.headers.get('Origin');
  const allowOrigin = configured === '*' || !origin ? configured : configured;
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(request, env, payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders(request, env)
  });
}

function requireKey(input) {
  const key = input?.key;
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new HttpError(400, 'Invalid key');
  }
  return key;
}

function parseStored(row) {
  if (!row) return null;
  return {
    v: Number(row.version),
    value: JSON.parse(row.value),
    updatedAt: Number(row.updated_at)
  };
}

function rowFromRecord(key, record) {
  return {
    key,
    version: record.v,
    value: JSON.stringify(record.value),
    updated_at: record.updatedAt
  };
}

async function getRecord(db, key) {
  const row = await db.prepare(
    'SELECT version, value, updated_at FROM state_store WHERE key = ?'
  ).bind(key).first();
  return parseStored(row);
}

async function getRecords(db, keys) {
  const statements = keys.map((key) => db.prepare(
    'SELECT version, value, updated_at FROM state_store WHERE key = ?'
  ).bind(key));
  const results = await db.batch(statements);
  const records = {};
  results.forEach((result, index) => {
    const row = result.results?.[0];
    if (row) records[keys[index]] = parseStored(row);
  });
  return records;
}

async function conflict(db, key) {
  return {conflict: true, key, current: await getRecord(db, key)};
}

async function setRecord(db, key, value, expectedVersion) {
  const now = nowMs();
  let row;
  if (expectedVersion === null || expectedVersion === undefined || Number(expectedVersion) === 0) {
    row = await db.prepare(
      `INSERT OR IGNORE INTO state_store(key, version, value, updated_at)
       VALUES(?, 1, ?, ?)
       RETURNING version, value, updated_at`
    ).bind(key, JSON.stringify(value), now).first();
  } else {
    row = await db.prepare(
      `UPDATE state_store
       SET version = version + 1, value = ?, updated_at = ?
       WHERE key = ? AND version = ?
       RETURNING version, value, updated_at`
    ).bind(JSON.stringify(value), now, key, Number(expectedVersion)).first();
  }
  return row ? parseStored(row) : conflict(db, key);
}

function normalizePath(path) {
  const parts = typeof path === 'string' ? path.split('.') : path;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 12) {
    throw new HttpError(400, 'Invalid field path');
  }
  return parts.map((part) => {
    const value = String(part);
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new HttpError(400, 'Invalid field path');
    }
    return value;
  });
}

function sqliteJsonPath(path) {
  return '$.' + normalizePath(path).join('.');
}

function mergeStatement(db, key, changes, now = nowMs()) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 40) {
    throw new HttpError(400, 'Invalid field changes');
  }
  let expression = `CASE WHEN json_type(value) = 'null' THEN '{}' ELSE value END`;
  const parameters = [];
  for (const change of changes) {
    if (!change || !Object.prototype.hasOwnProperty.call(change, 'path') ||
        !Object.prototype.hasOwnProperty.call(change, 'value')) {
      throw new HttpError(400, 'Invalid field change');
    }
    expression = `json_set(${expression}, ?, json(?))`;
    parameters.push(sqliteJsonPath(change.path), JSON.stringify(change.value));
  }
  return db.prepare(
    `UPDATE state_store
     SET version = version + 1, value = ${expression}, updated_at = ?
     WHERE key = ? AND json_type(value) IN ('object', 'null')
     RETURNING version, value, updated_at`
  ).bind(...parameters, now, key);
}

async function mergeFieldsRecord(db, key, changes) {
  const row = await mergeStatement(db, key, changes).first();
  if (row) return parseStored(row);
  throw new HttpError(409, 'Cannot merge fields into a missing or non-object value', {key});
}

async function appendRecord(db, key, item) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await getRecord(db, key);
    const now = nowMs();
    if (!current) {
      const inserted = await db.prepare(
        `INSERT OR IGNORE INTO state_store(key, version, value, updated_at)
         VALUES(?, 1, ?, ?)
         RETURNING version, value, updated_at`
      ).bind(key, JSON.stringify([item]), now).first();
      if (inserted) return {record: parseStored(inserted), deduped: false};
      continue;
    }
    if (!Array.isArray(current.value)) {
      throw new HttpError(409, 'Append target is not an array', {key});
    }
    if (item && typeof item === 'object' && item.p != null &&
        current.value.some((existing) => existing && existing.p === item.p)) {
      return {record: current, deduped: true};
    }
    const next = current.value.concat([item]);
    const row = await db.prepare(
      `UPDATE state_store
       SET version = version + 1, value = ?, updated_at = ?
       WHERE key = ? AND version = ?
       RETURNING version, value, updated_at`
    ).bind(JSON.stringify(next), now, key, current.v).first();
    if (row) return {record: parseStored(row), deduped: false};
  }
  throw new HttpError(409, 'Append conflicted too many times', {key});
}

function assertionForVersion(db, key, expectedVersion) {
  const expected = Number(expectedVersion || 0);
  if (expected === 0) {
    return db.prepare(
      `INSERT INTO batch_guard(value)
       SELECT NULL WHERE EXISTS(SELECT 1 FROM state_store WHERE key = ?)`
    ).bind(key);
  }
  return db.prepare(
    `INSERT INTO batch_guard(value)
     SELECT NULL WHERE NOT EXISTS(
       SELECT 1 FROM state_store WHERE key = ? AND version = ?
     )`
  ).bind(key, expected);
}

function assertionForObject(db, key) {
  return db.prepare(
    `INSERT INTO batch_guard(value)
     SELECT NULL WHERE NOT EXISTS(
       SELECT 1 FROM state_store
       WHERE key = ? AND json_type(value) IN ('object', 'null')
     )`
  ).bind(key);
}

function assertionForArrayOrMissing(db, key) {
  return db.prepare(
    `INSERT INTO batch_guard(value)
     SELECT NULL WHERE EXISTS(
       SELECT 1 FROM state_store
       WHERE key = ? AND json_type(value) != 'array'
     )`
  ).bind(key);
}

function replacementStatement(db, key, value, now) {
  return db.prepare(
    `INSERT INTO state_store(key, version, value, updated_at)
     VALUES(?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       version = state_store.version + 1,
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).bind(key, JSON.stringify(value), now);
}

function appendStatement(db, key, item, now) {
  const encoded = JSON.stringify(item);
  const player = item && typeof item === 'object' && item.p != null ? String(item.p) : null;
  const shouldAppend = player === null
    ? '1'
    : `NOT EXISTS(
         SELECT 1 FROM json_each(state_store.value)
         WHERE json_extract(json_each.value, '$.p') = ?
       )`;
  const params = player === null
    ? [key, JSON.stringify([item]), now, encoded, now]
    : [key, JSON.stringify([item]), now, player, encoded, player, player, now];
  return db.prepare(
    `INSERT INTO state_store(key, version, value, updated_at)
     VALUES(?, 1, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = CASE WHEN ${shouldAppend}
         THEN json_insert(state_store.value, '$[#]', json(?))
         ELSE state_store.value END,
       version = CASE WHEN ${player === null ? '1' : shouldAppend}
         THEN state_store.version + 1 ELSE state_store.version END,
       updated_at = CASE WHEN ${player === null ? '1' : shouldAppend}
         THEN ? ELSE state_store.updated_at END`
  ).bind(...params);
}

async function findBatchConflict(db, operations) {
  for (const operation of operations) {
    if (operation.op !== 'set') continue;
    const current = await getRecord(db, operation.key);
    const expected = Number(operation.expectedVersion || 0);
    if ((expected === 0 && current) || (expected > 0 && (!current || current.v !== expected))) {
      return {conflict: true, key: operation.key, current};
    }
  }
  return null;
}

async function batchOperation(db, operations) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 40) {
    throw new HttpError(400, 'Batch must contain between 1 and 40 operations');
  }
  const assertions = [];
  const writes = [];
  const keys = [];
  const now = nowMs();

  for (const operation of operations) {
    if (!operation || typeof operation !== 'object') {
      throw new HttpError(400, 'Invalid batch operation');
    }
    const key = requireKey(operation);
    const op = operation.op;
    keys.push(key);
    if (op === 'set') {
      if (!Object.prototype.hasOwnProperty.call(operation, 'value')) {
        throw new HttpError(400, 'Set operation requires value');
      }
      assertions.push(assertionForVersion(db, key, operation.expectedVersion));
      writes.push(replacementStatement(db, key, operation.value, now));
    } else if (op === 'merge_field' || op === 'merge_fields') {
      const changes = op === 'merge_field'
        ? [{path: operation.path, value: operation.value}]
        : operation.changes;
      assertions.push(assertionForObject(db, key));
      writes.push(mergeStatement(db, key, changes, now));
    } else if (op === 'append') {
      if (!Object.prototype.hasOwnProperty.call(operation, 'item')) {
        throw new HttpError(400, 'Append operation requires item');
      }
      assertions.push(assertionForArrayOrMissing(db, key));
      writes.push(appendStatement(db, key, operation.item, now));
    } else {
      throw new HttpError(400, 'Unsupported batch operation');
    }
  }

  const uniqueKeys = [...new Set(keys)];
  const placeholders = uniqueKeys.map(() => '?').join(',');
  const read = db.prepare(
    `SELECT key, version, value, updated_at FROM state_store
     WHERE key IN (${placeholders})`
  ).bind(...uniqueKeys);

  try {
    const results = await db.batch([...assertions, ...writes, read]);
    const rows = results.at(-1).results || [];
    const records = {};
    for (const row of rows) records[row.key] = parseStored(row);
    return {ok: true, records};
  } catch (error) {
    const conflictResult = await findBatchConflict(db, operations);
    if (conflictResult) return conflictResult;
    throw error;
  }
}

function activePieceIndicesAt(board, sector, slot) {
  const indices = [];
  board.pieces.forEach((piece, index) => {
    if (!piece.removed && piece.sector === sector && Number(piece.slot) === slot) indices.push(index);
  });
  return indices;
}

function alignedIndicesAt(board, sector, slot) {
  const indices = activePieceIndicesAt(board, sector, slot);
  const colors = new Set(indices.map((index) => board.pieces[index].color));
  return colors.has('research') && colors.has('patient') ? indices : [];
}

function findPieceIndex(board, pieceId) {
  return board.pieces.findIndex((piece) => Number(piece.id) === pieceId);
}

function validateAndApplyMove(input, records) {
  const {room, team, dieIndex, move} = input;
  const cfgKey = `room_${room}_cfg`;
  const boardKey = `room_${room}_board`;
  const diceKey = `room_${room}_dice_${team}`;
  const selectionKey = `room_${room}_sel_${team}`;
  const cfgRecord = records[cfgKey];
  const boardRecord = records[boardKey];
  const diceRecord = records[diceKey];
  const selectionRecord = records[selectionKey];
  if (!cfgRecord || !boardRecord || !diceRecord) {
    throw new HttpError(409, 'Game state is incomplete');
  }

  const cfg = clone(cfgRecord.value);
  const board = clone(boardRecord.value);
  const dice = clone(diceRecord.value);
  if (cfg.phase !== 'playing' || cfg.roundPhase !== 'rolling') {
    throw new HttpError(409, 'Moves are not allowed in the current phase');
  }
  if (!board || !Array.isArray(board.pieces)) throw new HttpError(409, 'Board state is invalid');
  if (!dice || !Array.isArray(dice.rolls) || dice.rolls[dieIndex] == null) {
    throw new HttpError(409, 'Die does not exist');
  }
  if (dice.used?.[dieIndex]) throw new HttpError(409, 'Die has already been used');
  const dieValue = Number(dice.rolls[dieIndex]);
  if (!Number.isInteger(dieValue) || dieValue < 1 || dieValue > 3) {
    throw new HttpError(409, 'Die value is invalid');
  }
  const card = cfg.envDeck?.[Number(cfg.envShown)];
  if (!card?.type) throw new HttpError(409, 'Environment card is invalid');

  if (card.type === 'challenge') {
    if (move.type !== 'backward') throw new HttpError(409, 'Challenge rounds require a backward move');
    const pieceId = Number(move.pieceId);
    if (!Number.isInteger(pieceId)) throw new HttpError(400, 'Invalid piece');
    const index = findPieceIndex(board, pieceId);
    if (index < 0 || board.pieces[index].removed) throw new HttpError(409, 'Piece is unavailable');
    const piece = board.pieces[index];
    const length = SECTOR_LENGTHS[piece.sector];
    const slot = Number(piece.slot);
    if (!length || slot >= length - 1) throw new HttpError(409, 'A completed piece cannot move backward');
    if (alignedIndicesAt(board, piece.sector, slot).length) {
      throw new HttpError(409, 'Aligned pieces cannot move backward');
    }
    const nextSlot = slot - dieValue;
    if (nextSlot < 0) board.pieces[index].removed = true;
    else board.pieces[index].slot = nextSlot;
  } else if (card.type === 'value') {
    if (move.type === 'place') {
      const sector = String(move.sector || '');
      const color = String(move.color || '');
      if (!SECTOR_LENGTHS[sector] || !['research', 'patient'].includes(color)) {
        throw new HttpError(400, 'Invalid piece placement');
      }
      const selectedColor = selectionRecord?.value?.outcomeColor;
      if (selectedColor !== color) {
        throw new HttpError(409, 'Piece color does not match the selected outcome');
      }
      const nextId = Math.max(1, Number(board.nextId || 1));
      board.pieces.push({
        id: nextId,
        team,
        color,
        sector,
        slot: Math.min(SECTOR_LENGTHS[sector] - 1, Math.max(0, dieValue - 1)),
        removed: false
      });
      board.nextId = nextId + 1;
    } else if (move.type === 'forward') {
      const pieceId = Number(move.pieceId);
      const destination = Number(move.destination);
      if (!Number.isInteger(pieceId) || !Number.isInteger(destination)) {
        throw new HttpError(400, 'Invalid forward move');
      }
      const index = findPieceIndex(board, pieceId);
      if (index < 0 || board.pieces[index].removed) throw new HttpError(409, 'Piece is unavailable');
      const piece = board.pieces[index];
      const length = SECTOR_LENGTHS[piece.sector];
      const slot = Number(piece.slot);
      if (!length) throw new HttpError(409, 'Piece sector is invalid');
      const aligned = alignedIndicesAt(board, piece.sector, slot);
      if (piece.team !== team && aligned.length === 0) {
        throw new HttpError(409, 'Only your team or an aligned group may be moved');
      }
      const maxStep = aligned.length ? dieValue * 2 : dieValue;
      if (destination <= slot || destination > slot + maxStep || destination >= length) {
        throw new HttpError(409, 'Destination is out of range');
      }
      if (aligned.length) aligned.forEach((pieceIndex) => { board.pieces[pieceIndex].slot = destination; });
      else board.pieces[index].slot = destination;
    } else {
      throw new HttpError(409, 'Value rounds require a place or forward move');
    }
  } else {
    throw new HttpError(409, 'Unknown environment card type');
  }

  if (!Array.isArray(dice.used)) dice.used = dice.rolls.map(() => false);
  dice.used[dieIndex] = true;
  return {cfgKey, boardKey, diceKey, selectionKey, cfgRecord, boardRecord, diceRecord, selectionRecord, board, dice};
}

async function applyMove(db, input) {
  const room = String(input.room || '').toUpperCase();
  const team = String(input.team || '');
  const actionId = String(input.actionId || '');
  const dieIndex = Number(input.dieIndex);
  const move = input.move;
  if (!ROOM_RE.test(room)) throw new HttpError(400, 'Invalid room');
  if (!TEAMS.has(team)) throw new HttpError(400, 'Invalid team');
  if (!ACTION_RE.test(actionId)) throw new HttpError(400, 'Invalid actionId');
  if (!Number.isInteger(dieIndex) || dieIndex < 0 || !move || typeof move !== 'object') {
    throw new HttpError(400, 'Invalid move request');
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const prior = await db.prepare('SELECT response FROM action_log WHERE action_id = ?')
      .bind(actionId).first('response');
    if (prior) return {...JSON.parse(prior), replayed: true};

    const keys = [
      `room_${room}_cfg`,
      `room_${room}_board`,
      `room_${room}_dice_${team}`,
      `room_${room}_sel_${team}`
    ];
    const records = await getRecords(db, keys);
    const computed = validateAndApplyMove({room, team, dieIndex, move}, records);
    const now = nowMs();
    const boardResult = {v: computed.boardRecord.v + 1, value: computed.board, updatedAt: now};
    const diceResult = {v: computed.diceRecord.v + 1, value: computed.dice, updatedAt: now};
    const response = {
      ok: true,
      actionId,
      records: {
        [computed.boardKey]: boardResult,
        [computed.diceKey]: diceResult
      }
    };

    const assertions = [
      assertionForVersion(db, computed.cfgKey, computed.cfgRecord.v),
      assertionForVersion(db, computed.boardKey, computed.boardRecord.v),
      assertionForVersion(db, computed.diceKey, computed.diceRecord.v)
    ];
    if (computed.selectionRecord) {
      assertions.push(assertionForVersion(db, computed.selectionKey, computed.selectionRecord.v));
    }
    const writes = [
      db.prepare(
        `UPDATE state_store SET version = version + 1, value = ?, updated_at = ?
         WHERE key = ? AND version = ?`
      ).bind(JSON.stringify(computed.board), now, computed.boardKey, computed.boardRecord.v),
      db.prepare(
        `UPDATE state_store SET version = version + 1, value = ?, updated_at = ?
         WHERE key = ? AND version = ?`
      ).bind(JSON.stringify(computed.dice), now, computed.diceKey, computed.diceRecord.v),
      db.prepare(
        `INSERT INTO action_log(action_id, room, response, created_at)
         VALUES(?, ?, ?, ?)`
      ).bind(actionId, room, JSON.stringify(response), now)
    ];
    try {
      await db.batch([...assertions, ...writes]);
      return response;
    } catch (error) {
      const replay = await db.prepare('SELECT response FROM action_log WHERE action_id = ?')
        .bind(actionId).first('response');
      if (replay) return {...JSON.parse(replay), replayed: true};
      if (attempt === 5) throw new HttpError(409, 'Move conflicted too many times');
    }
  }
  throw new HttpError(409, 'Move conflicted too many times');
}

async function getSnapshot(db, room) {
  const prefix = `room_${room}_`;
  const rows = await db.prepare(
    `SELECT key, version, value, updated_at FROM state_store
     WHERE substr(key, 1, ?) = ? ORDER BY key`
  ).bind(prefix.length, prefix).all();
  const records = {};
  for (const row of rows.results || []) records[row.key] = parseStored(row);
  return {records};
}

async function listRooms(db) {
  const rows = await db.prepare(
    `SELECT key, version, value, updated_at FROM state_store
     WHERE key GLOB 'room_*_cfg' ORDER BY updated_at DESC`
  ).all();
  const rooms = [];
  for (const row of rows.results || []) {
    const match = /^room_([A-Z2-9]{4})_cfg$/.exec(row.key);
    if (!match) continue;
    const code = match[1];
    const prefix = `room_${code}_`;
    const activity = await db.prepare(
      `SELECT MAX(updated_at) AS last_activity, COUNT(*) AS item_count
       FROM state_store WHERE substr(key, 1, ?) = ?`
    ).bind(prefix.length, prefix).first();
    const cfg = JSON.parse(row.value);
    rooms.push({
      code,
      created: cfg.ts || Number(row.updated_at),
      lastActivity: Number(activity.last_activity),
      tables: cfg.tables || {},
      fileCount: Number(activity.item_count)
    });
  }
  return rooms;
}

async function handleGet(request, env, url) {
  if (url.searchParams.has('snapshot')) {
    const room = String(url.searchParams.get('snapshot') || '').toUpperCase();
    if (!ROOM_RE.test(room)) throw new HttpError(400, 'Invalid room');
    return jsonResponse(request, env, await getSnapshot(env.DB, room));
  }
  if (url.searchParams.has('list_rooms')) {
    return jsonResponse(request, env, await listRooms(env.DB));
  }
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) throw new HttpError(400, 'Invalid key');
  return jsonResponse(request, env, await getRecord(env.DB, key));
}

async function handlePost(request, env) {
  let input;
  try {
    input = await request.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Invalid JSON body');
  }
  let action = input.action;
  if (!action) {
    if (Object.prototype.hasOwnProperty.call(input, 'append')) action = 'append';
    else if (Object.prototype.hasOwnProperty.call(input, 'merge_table')) action = 'merge_table';
    else if (Object.prototype.hasOwnProperty.call(input, 'value')) action = 'set';
  }

  if (action === 'set') {
    const key = requireKey(input);
    if (!Object.prototype.hasOwnProperty.call(input, 'value')) throw new HttpError(400, 'Missing value');
    const record = await setRecord(env.DB, key, input.value, input.expectedVersion);
    if (record.conflict) return jsonResponse(request, env, record, 409);
    return jsonResponse(request, env, {ok: true, key, record});
  }
  if (action === 'merge_field' || action === 'merge_fields') {
    const key = requireKey(input);
    const changes = action === 'merge_field'
      ? [{path: input.path, value: input.value}]
      : input.changes;
    const record = await mergeFieldsRecord(env.DB, key, changes);
    return jsonResponse(request, env, {ok: true, key, record});
  }
  if (action === 'append') {
    const key = requireKey(input);
    const item = Object.prototype.hasOwnProperty.call(input, 'item') ? input.item : input.append;
    const result = await appendRecord(env.DB, key, item);
    return jsonResponse(request, env, {ok: true, key, ...result});
  }
  if (action === 'merge_table') {
    const key = requireKey(input);
    const tableKey = String(input.tableKey || input.merge_table || '');
    if (!KEY_RE.test(tableKey)) throw new HttpError(400, 'Invalid table key');
    const record = await mergeFieldsRecord(env.DB, key, [{
      path: ['tables', tableKey],
      value: {display: String(input.display || tableKey)}
    }]);
    return jsonResponse(request, env, {ok: true, key, record});
  }
  if (action === 'batch') {
    const result = await batchOperation(env.DB, input.operations);
    return jsonResponse(request, env, result, result.conflict ? 409 : 200);
  }
  if (action === 'reset_prefix') {
    const prefix = String(input.prefix || '');
    if (!KEY_RE.test(prefix) || !prefix.startsWith('room_')) throw new HttpError(400, 'Invalid reset prefix');
    const statements = [
      env.DB.prepare('DELETE FROM state_store WHERE substr(key, 1, ?) = ?').bind(prefix.length, prefix)
    ];
    const match = /^room_([A-Z2-9]{4})_/.exec(prefix);
    if (match) statements.push(env.DB.prepare('DELETE FROM action_log WHERE room = ?').bind(match[1]));
    const results = await env.DB.batch(statements);
    return jsonResponse(request, env, {ok: true, deleted: Number(results[0].meta?.changes || 0)});
  }
  if (action === 'apply_move') {
    return jsonResponse(request, env, await applyMove(env.DB, input));
  }
  throw new HttpError(400, 'Unknown action');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: jsonHeaders(request, env)});
    }
    try {
      const url = new URL(request.url);
      if (request.method === 'GET') return await handleGet(request, env, url);
      if (request.method === 'POST') return await handlePost(request, env);
      throw new HttpError(405, 'Method not allowed');
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(request, env, {error: error.message, ...error.data}, error.status);
      }
      console.error(error);
      return jsonResponse(request, env, {error: 'Server error'}, 500);
    }
  }
};
