// Version-aware synchronization helpers for Broadening Circles.
// The server is authoritative. Reads carry versions, stale responses are ignored,
// and game actions are committed atomically by sync.php.

// The retained PHP edition uses sync.php. GitHub Pages overwrites config.js
// during deployment so the same client talks to the Cloudflare Worker instead.
var SYNC = (typeof window !== 'undefined' && window.BC_SYNC_URL) || 'sync.php';
var POLL_MS = 2000;

var SyncState = {
  versions: Object.create(null),
  values: Object.create(null),
  pending: Object.create(null),
  statusTimer: null
};

function syncClone(value){
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function syncHas(obj, key){
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function syncVersion(key){
  return syncHas(SyncState.versions, key) ? SyncState.versions[key] : 0;
}

function syncCached(key){
  return syncHas(SyncState.values, key) ? syncClone(SyncState.values[key]) : null;
}

function syncRemember(key, record){
  if (!record || typeof record.v !== 'number' || !syncHas(record, 'value')) return null;
  var known = syncVersion(key);
  if (record.v < known) {
    return { v: known, value: syncCached(key), stale: true };
  }
  SyncState.versions[key] = record.v;
  SyncState.values[key] = syncClone(record.value);
  return { v: record.v, value: syncClone(record.value), stale: false };
}

function syncRememberRecords(records){
  var values = {};
  Object.keys(records || {}).forEach(function(key){
    var remembered = syncRemember(key, records[key]);
    if (remembered) values[key] = remembered.value;
  });
  return values;
}

function syncStatusHost(){
  if (typeof document === 'undefined' || !document.body) return null;
  var host = document.getElementById('bcSyncStatus');
  if (!host) {
    host = document.createElement('div');
    host.id = 'bcSyncStatus';
    host.className = 'bc-sync-status';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

function syncShowStatus(message, type, persist){
  var host = syncStatusHost();
  if (!host) return;
  host.textContent = message || '';
  host.className = 'bc-sync-status show ' + (type || 'info');
  if (SyncState.statusTimer) clearTimeout(SyncState.statusTimer);
  if (!persist) {
    SyncState.statusTimer = setTimeout(function(){ host.className = 'bc-sync-status'; }, 3500);
  }
}

function syncErrorMessage(error){
  if (error && error.data && error.data.error) return error.data.error;
  return error && error.message ? error.message : 'Could not synchronize game state.';
}

function syncReportError(error){
  if (typeof console !== 'undefined' && console.error) console.error(error);
  syncShowStatus(syncErrorMessage(error), 'error', true);
}

async function syncRequest(url, options){
  var response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    var networkError = new Error('Connection lost. Changes were not saved.');
    networkError.cause = cause;
    throw networkError;
  }

  var data = null;
  try { data = await response.json(); }
  catch (cause) {
    var parseError = new Error('The sync server returned an invalid response.');
    parseError.status = response.status;
    parseError.cause = cause;
    throw parseError;
  }

  if (!response.ok) {
    var requestError = new Error((data && data.error) || ('Sync request failed ('+response.status+').'));
    requestError.status = response.status;
    requestError.data = data;
    throw requestError;
  }
  return data;
}

async function sGet(k){
  try {
    var record = await syncRequest(SYNC+'?key='+encodeURIComponent(k));
    if (record === null) return null;
    var remembered = syncRemember(k, record);
    return remembered ? remembered.value : null;
  } catch (error) {
    syncReportError(error);
    return syncCached(k);
  }
}

async function sSnapshot(code){
  try {
    var response = await syncRequest(SYNC+'?snapshot='+encodeURIComponent(code));
    return syncRememberRecords(response.records || {});
  } catch (error) {
    syncReportError(error);
    var prefix = 'room_'+code+'_';
    var cached = {};
    Object.keys(SyncState.values).forEach(function(key){
      if (key.indexOf(prefix) === 0) cached[key] = syncCached(key);
    });
    return cached;
  }
}

async function syncPostSet(k, value, expectedVersion){
  return syncRequest(SYNC, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      action: 'set', key: k, value: value,
      expectedVersion: expectedVersion
    })
  });
}

// For a whole-value write, callers may provide a reapply function. If another
// client wins the version race, reapply receives the server's fresh value and
// must return the user's intended change layered onto that value.
async function sSet(k, value, reapply){
  try {
    var response = await syncPostSet(k, value, syncVersion(k));
    syncRemember(k, response.record);
    return syncClone(response.record.value);
  } catch (error) {
    var current = error.data && error.data.current;
    if (current) syncRemember(k, current);
    if (error.status === 409 && current && typeof reapply === 'function') {
      try {
        var reapplied = reapply(syncClone(current.value), syncClone(value));
        var retried = await syncPostSet(k, reapplied, current.v);
        syncRemember(k, retried.record);
        syncShowStatus('A concurrent change was merged safely.', 'info', false);
        return syncClone(retried.record.value);
      } catch (retryError) {
        if (retryError.data && retryError.data.current) syncRemember(k, retryError.data.current);
        syncReportError(retryError);
        throw retryError;
      }
    }
    syncReportError(error);
    throw error;
  }
}

async function sMergeField(k, path, value){
  return sMergeFields(k, [{path:path, value:value}]);
}

async function sMergeFields(k, changes){
  try {
    var response = await syncRequest(SYNC, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({action:'merge_fields', key:k, changes:changes})
    });
    syncRemember(k, response.record);
    return syncClone(response.record.value);
  } catch (error) {
    syncReportError(error);
    throw error;
  }
}

async function sAppend(k, item){
  try {
    var response = await syncRequest(SYNC, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({action:'append', key:k, item:item})
    });
    syncRemember(k, response.record);
    return { value: syncClone(response.record.value), deduped: !!response.deduped };
  } catch (error) {
    syncReportError(error);
    throw error;
  }
}

async function sBatch(operations){
  var prepared = operations.map(function(operation){
    var op = Object.assign({}, operation);
    if (op.op === 'set' && !syncHas(op, 'expectedVersion')) {
      op.expectedVersion = syncVersion(op.key);
    }
    return op;
  });
  try {
    var response = await syncRequest(SYNC, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({action:'batch', operations:prepared})
    });
    return syncRememberRecords(response.records || {});
  } catch (error) {
    if (error.data && error.data.current && error.data.key) {
      syncRemember(error.data.key, error.data.current);
    }
    syncReportError(error);
    throw error;
  }
}

async function sApplyMove(room, team, dieIndex, move, actionId){
  try {
    var response = await syncRequest(SYNC, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        action:'apply_move', room:room, team:team, dieIndex:dieIndex,
        move:move, actionId:actionId || newActionId()
      })
    });
    return { values: syncRememberRecords(response.records || {}), replayed: !!response.replayed };
  } catch (error) {
    syncReportError(error);
    throw error;
  }
}

async function sReset(prefix){
  try {
    var response = await syncRequest(SYNC, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'reset_prefix', prefix:prefix})
    });
    Object.keys(SyncState.values).forEach(function(key){
      if (key.indexOf(prefix) === 0) {
        delete SyncState.values[key];
        delete SyncState.versions[key];
      }
    });
    return response;
  } catch (error) {
    syncReportError(error);
    throw error;
  }
}

function newActionId(){
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'act_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12);
}

function guard(name, fn){
  if (SyncState.pending[name]) return Promise.resolve(null);
  SyncState.pending[name] = true;
  return Promise.resolve().then(fn).finally(function(){ SyncState.pending[name] = false; });
}

// Generate 4-char room code
function genRoomCode(){
  var alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i=0;i<4;i++) s += alpha[Math.floor(Math.random()*alpha.length)];
  return s;
}

function rKey(code, part){ return 'room_'+code+'_'+part; }

// Create initial cfg
function newCfg(code){
  return {
    code: code,
    ts: Date.now(),
    phase: 'lobby',
    roundPhase: 'idle',
    round: 0,
    firstTeamIdx: 0,
    teamOrder: ['research','patient','balanced'],
    sectorAssignments: null,
    envDeck: [],
    envShown: -1,
    timer: null,
    extraDieTo: null,
    tables: {}
  };
}

// Non-overlapping poller: the next request begins only after the prior one settles.
function makePoller(fn){
  var handle = { id:null, running:false };
  function tick(){
    if (!handle.running) return;
    Promise.resolve().then(fn).catch(syncReportError).finally(function(){
      if (handle.running) handle.id = setTimeout(tick, POLL_MS);
    });
  }
  handle.start = function(){ if (handle.running) return; handle.running = true; tick(); };
  handle.stop = function(){ handle.running = false; if (handle.id) clearTimeout(handle.id); };
  return handle;
}

function timerRemaining(timer){
  if (!timer || !timer.startTs) return null;
  var elapsed = (Date.now() - timer.startTs) / 1000;
  return Math.max(0, Math.round(timer.duration - elapsed));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SyncState: SyncState,
    syncRemember: syncRemember,
    syncVersion: syncVersion,
    syncCached: syncCached,
    sGet: sGet,
    sSnapshot: sSnapshot,
    sSet: sSet,
    sMergeField: sMergeField,
    sMergeFields: sMergeFields,
    sAppend: sAppend,
    sBatch: sBatch,
    sApplyMove: sApplyMove,
    newActionId: newActionId,
    guard: guard,
    makePoller: makePoller,
    rKey: rKey
  };
}
