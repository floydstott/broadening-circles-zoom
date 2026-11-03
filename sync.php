<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function respond($payload, int $status = 200): void {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function now_ms(): int {
    return (int) floor(microtime(true) * 1000);
}

function valid_key($key): bool {
    return is_string($key) && $key !== '' && strlen($key) <= 160
        && preg_match('/^[A-Za-z0-9_-]+$/', $key) === 1;
}

function require_key(array $input): string {
    $key = $input['key'] ?? '';
    if (!valid_key($key)) respond(['error' => 'Invalid key'], 400);
    return $key;
}

function decode_value(string $json) {
    $value = json_decode($json, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        throw new RuntimeException('Stored JSON is invalid');
    }
    return $value;
}

function encode_value($value): string {
    $json = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) throw new InvalidArgumentException('Value cannot be encoded as JSON');
    return $json;
}

function open_db(): PDO {
    $defaultPath = __DIR__ . '/data/broadening_circles.sqlite';
    $dbPath = getenv('BC_DB_PATH') ?: $defaultPath;
    $dir = dirname($dbPath);
    if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
        throw new RuntimeException('Could not create database directory');
    }

    $db = new PDO('sqlite:' . $dbPath);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $db->exec('PRAGMA busy_timeout = 5000');
    $db->exec('PRAGMA journal_mode = WAL');
    $db->exec('PRAGMA synchronous = NORMAL');
    $db->exec(
        'CREATE TABLE IF NOT EXISTS state_store (
            key TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )'
    );
    $db->exec(
        'CREATE TABLE IF NOT EXISTS action_log (
            action_id TEXT PRIMARY KEY,
            room TEXT NOT NULL,
            response TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )'
    );
    $db->exec('CREATE INDEX IF NOT EXISTS action_log_room_idx ON action_log(room)');
    $db->exec(
        'CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )'
    );
    return $db;
}

function begin_immediate(PDO $db): void {
    $db->exec('BEGIN IMMEDIATE');
}

function rollback_quietly(PDO $db): void {
    try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {}
}

function migrate_legacy_json(PDO $db): void {
    $check = $db->prepare('SELECT value FROM metadata WHERE key = ?');
    $check->execute(['legacy_json_import_v1']);
    if ($check->fetchColumn() !== false) return;

    begin_immediate($db);
    try {
        $insert = $db->prepare(
            'INSERT OR IGNORE INTO state_store(key, version, value, updated_at) VALUES(?, 1, ?, ?)'
        );
        foreach (glob(__DIR__ . '/data/room_*.json') ?: [] as $file) {
            $key = pathinfo($file, PATHINFO_FILENAME);
            if (!valid_key($key)) continue;
            $raw = file_get_contents($file);
            if ($raw === false) continue;
            json_decode($raw, true);
            if (json_last_error() !== JSON_ERROR_NONE) continue;
            $insert->execute([$key, $raw, ((int) filemtime($file)) * 1000]);
        }
        $mark = $db->prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)');
        $mark->execute(['legacy_json_import_v1', (string) now_ms()]);
        $db->exec('COMMIT');
    } catch (Throwable $e) {
        rollback_quietly($db);
        throw $e;
    }
}

function get_record(PDO $db, string $key): ?array {
    $stmt = $db->prepare('SELECT version, value, updated_at FROM state_store WHERE key = ?');
    $stmt->execute([$key]);
    $row = $stmt->fetch();
    if (!$row) return null;
    return [
        'v' => (int) $row['version'],
        'value' => decode_value($row['value']),
        'updatedAt' => (int) $row['updated_at'],
    ];
}

function conflict_result(PDO $db, string $key): array {
    return ['conflict' => true, 'key' => $key, 'current' => get_record($db, $key)];
}

function set_record(PDO $db, string $key, $value, $expectedVersion): array {
    $current = get_record($db, $key);
    $now = now_ms();
    $encoded = encode_value($value);

    if ($current === null) {
        if ($expectedVersion !== null && (int) $expectedVersion !== 0) {
            return conflict_result($db, $key);
        }
        $stmt = $db->prepare(
            'INSERT OR IGNORE INTO state_store(key, version, value, updated_at) VALUES(?, 1, ?, ?)'
        );
        $stmt->execute([$key, $encoded, $now]);
        if ($stmt->rowCount() !== 1) return conflict_result($db, $key);
        return ['v' => 1, 'value' => $value, 'updatedAt' => $now];
    }

    if ($expectedVersion === null || (int) $expectedVersion !== $current['v']) {
        return conflict_result($db, $key);
    }

    $nextVersion = $current['v'] + 1;
    $stmt = $db->prepare(
        'UPDATE state_store SET version = ?, value = ?, updated_at = ? WHERE key = ? AND version = ?'
    );
    $stmt->execute([$nextVersion, $encoded, $now, $key, $current['v']]);
    if ($stmt->rowCount() !== 1) return conflict_result($db, $key);
    return ['v' => $nextVersion, 'value' => $value, 'updatedAt' => $now];
}

function save_current_record(PDO $db, string $key, array $current, $value): array {
    $now = now_ms();
    $nextVersion = $current['v'] + 1;
    $stmt = $db->prepare(
        'UPDATE state_store SET version = ?, value = ?, updated_at = ? WHERE key = ? AND version = ?'
    );
    $stmt->execute([$nextVersion, encode_value($value), $now, $key, $current['v']]);
    if ($stmt->rowCount() !== 1) throw new RuntimeException('Concurrent update inside transaction');
    return ['v' => $nextVersion, 'value' => $value, 'updatedAt' => $now];
}

function normalize_path($path): array {
    if (is_string($path)) $path = explode('.', $path);
    if (!is_array($path) || count($path) < 1 || count($path) > 12) {
        respond(['error' => 'Invalid field path'], 400);
    }
    $parts = [];
    foreach ($path as $part) {
        $part = (string) $part;
        if ($part === '' || preg_match('/^[A-Za-z0-9_-]+$/', $part) !== 1) {
            respond(['error' => 'Invalid field path'], 400);
        }
        $parts[] = $part;
    }
    return $parts;
}

function set_path_value(array &$root, array $path, $value): void {
    $cursor =& $root;
    $last = array_pop($path);
    foreach ($path as $part) {
        if (!isset($cursor[$part]) || !is_array($cursor[$part])) $cursor[$part] = [];
        $cursor =& $cursor[$part];
    }
    $cursor[$last] = $value;
}

function merge_fields_record(PDO $db, string $key, array $changes): array {
    $current = get_record($db, $key);
    if ($current === null) {
        respond(['error' => 'Cannot merge fields into a missing or non-object value', 'key' => $key], 409);
    }
    // Legacy dice records used null between rounds. Treat null as an empty object so
    // the first field merge upgrades those rows without a destructive full rewrite.
    if ($current['value'] !== null && !is_array($current['value'])) {
        respond(['error' => 'Cannot merge fields into a missing or non-object value', 'key' => $key], 409);
    }
    $value = $current['value'] === null ? [] : $current['value'];
    foreach ($changes as $change) {
        if (!is_array($change) || !array_key_exists('path', $change) || !array_key_exists('value', $change)) {
            respond(['error' => 'Invalid field change'], 400);
        }
        set_path_value($value, normalize_path($change['path']), $change['value']);
    }
    return save_current_record($db, $key, $current, $value);
}

function append_record(PDO $db, string $key, $item): array {
    $current = get_record($db, $key);
    if ($current === null) {
        $record = set_record($db, $key, [$item], null);
        return ['record' => $record, 'deduped' => false];
    }
    $items = $current['value'];
    if (!is_array($items)) respond(['error' => 'Append target is not an array', 'key' => $key], 409);

    if (is_array($item) && isset($item['p'])) {
        foreach ($items as $existing) {
            if (is_array($existing) && isset($existing['p']) && $existing['p'] === $item['p']) {
                return ['record' => $current, 'deduped' => true];
            }
        }
    }
    $items[] = $item;
    return ['record' => save_current_record($db, $key, $current, $items), 'deduped' => false];
}

function batch_operation(PDO $db, array $operations): array {
    if (count($operations) < 1 || count($operations) > 40) {
        respond(['error' => 'Batch must contain between 1 and 40 operations'], 400);
    }
    $records = [];
    foreach ($operations as $operation) {
        if (!is_array($operation)) respond(['error' => 'Invalid batch operation'], 400);
        $op = $operation['op'] ?? '';
        $key = require_key($operation);
        if ($op === 'set') {
            if (!array_key_exists('value', $operation)) respond(['error' => 'Set operation requires value'], 400);
            $record = set_record($db, $key, $operation['value'], $operation['expectedVersion'] ?? null);
            if (!empty($record['conflict'])) return $record;
            $records[$key] = $record;
        } elseif ($op === 'merge_field') {
            if (!array_key_exists('path', $operation) || !array_key_exists('value', $operation)) {
                respond(['error' => 'merge_field requires path and value'], 400);
            }
            $records[$key] = merge_fields_record($db, $key, [[
                'path' => $operation['path'],
                'value' => $operation['value'],
            ]]);
        } elseif ($op === 'merge_fields') {
            $changes = $operation['changes'] ?? null;
            if (!is_array($changes)) respond(['error' => 'merge_fields requires changes'], 400);
            $records[$key] = merge_fields_record($db, $key, $changes);
        } elseif ($op === 'append') {
            if (!array_key_exists('item', $operation)) respond(['error' => 'Append operation requires item'], 400);
            $result = append_record($db, $key, $operation['item']);
            $records[$key] = $result['record'];
        } else {
            respond(['error' => 'Unsupported batch operation'], 400);
        }
    }
    return ['ok' => true, 'records' => $records];
}

function active_piece_indices_at(array $board, string $sector, int $slot): array {
    $indices = [];
    foreach ($board['pieces'] as $index => $piece) {
        if (empty($piece['removed']) && ($piece['sector'] ?? '') === $sector && (int) ($piece['slot'] ?? -1) === $slot) {
            $indices[] = $index;
        }
    }
    return $indices;
}

function aligned_indices_at(array $board, string $sector, int $slot): array {
    $indices = active_piece_indices_at($board, $sector, $slot);
    $colors = [];
    foreach ($indices as $index) $colors[$board['pieces'][$index]['color'] ?? ''] = true;
    return !empty($colors['research']) && !empty($colors['patient']) ? $indices : [];
}

function find_piece_index(array $board, int $pieceId): int {
    foreach ($board['pieces'] as $index => $piece) {
        if ((int) ($piece['id'] ?? 0) === $pieceId) return (int) $index;
    }
    return -1;
}

function apply_move(PDO $db, array $input): array {
    $room = strtoupper((string) ($input['room'] ?? ''));
    $team = (string) ($input['team'] ?? '');
    $actionId = (string) ($input['actionId'] ?? '');
    $dieIndex = filter_var($input['dieIndex'] ?? null, FILTER_VALIDATE_INT);
    $move = $input['move'] ?? null;
    if (preg_match('/^[A-Z2-9]{4}$/', $room) !== 1) respond(['error' => 'Invalid room'], 400);
    if (!in_array($team, ['research', 'patient', 'balanced'], true)) respond(['error' => 'Invalid team'], 400);
    if (preg_match('/^[A-Za-z0-9_-]{12,120}$/', $actionId) !== 1) respond(['error' => 'Invalid actionId'], 400);
    if ($dieIndex === false || $dieIndex < 0 || !is_array($move)) respond(['error' => 'Invalid move request'], 400);

    $seen = $db->prepare('SELECT response FROM action_log WHERE action_id = ?');
    $seen->execute([$actionId]);
    $prior = $seen->fetchColumn();
    if ($prior !== false) {
        $response = decode_value($prior);
        $response['replayed'] = true;
        return $response;
    }

    $cfgKey = 'room_' . $room . '_cfg';
    $boardKey = 'room_' . $room . '_board';
    $diceKey = 'room_' . $room . '_dice_' . $team;
    $selectionKey = 'room_' . $room . '_sel_' . $team;
    $cfgRecord = get_record($db, $cfgKey);
    $boardRecord = get_record($db, $boardKey);
    $diceRecord = get_record($db, $diceKey);
    $selectionRecord = get_record($db, $selectionKey);
    if (!$cfgRecord || !$boardRecord || !$diceRecord) respond(['error' => 'Game state is incomplete'], 409);

    $cfg = $cfgRecord['value'];
    $board = $boardRecord['value'];
    $dice = $diceRecord['value'];
    if (($cfg['phase'] ?? '') !== 'playing' || ($cfg['roundPhase'] ?? '') !== 'rolling') {
        respond(['error' => 'Moves are not allowed in the current phase'], 409);
    }
    if (!is_array($board) || !isset($board['pieces']) || !is_array($board['pieces'])) {
        respond(['error' => 'Board state is invalid'], 409);
    }
    if (!is_array($dice) || !isset($dice['rolls'][$dieIndex])) respond(['error' => 'Die does not exist'], 409);
    if (!empty($dice['used'][$dieIndex])) respond(['error' => 'Die has already been used'], 409);
    $dieValue = (int) $dice['rolls'][$dieIndex];
    if ($dieValue < 1 || $dieValue > 3) respond(['error' => 'Die value is invalid'], 409);

    $envShown = (int) ($cfg['envShown'] ?? -1);
    $card = $cfg['envDeck'][$envShown] ?? null;
    if (!is_array($card) || !isset($card['type'])) respond(['error' => 'Environment card is invalid'], 409);

    $sectorLengths = ['easy' => 9, 'medium' => 13, 'hard' => 20];
    $moveType = (string) ($move['type'] ?? '');

    if ($card['type'] === 'challenge') {
        if ($moveType !== 'backward') respond(['error' => 'Challenge rounds require a backward move'], 409);
        $pieceId = filter_var($move['pieceId'] ?? null, FILTER_VALIDATE_INT);
        if ($pieceId === false) respond(['error' => 'Invalid piece'], 400);
        $pieceIndex = find_piece_index($board, $pieceId);
        if ($pieceIndex < 0 || !empty($board['pieces'][$pieceIndex]['removed'])) respond(['error' => 'Piece is unavailable'], 409);
        $piece = $board['pieces'][$pieceIndex];
        $sector = (string) ($piece['sector'] ?? '');
        $slot = (int) ($piece['slot'] ?? -1);
        if (!isset($sectorLengths[$sector]) || $slot >= $sectorLengths[$sector] - 1) {
            respond(['error' => 'A completed piece cannot move backward'], 409);
        }
        if (count(aligned_indices_at($board, $sector, $slot)) > 0) {
            respond(['error' => 'Aligned pieces cannot move backward'], 409);
        }
        $nextSlot = $slot - $dieValue;
        if ($nextSlot < 0) {
            $board['pieces'][$pieceIndex]['removed'] = true;
        } else {
            $board['pieces'][$pieceIndex]['slot'] = $nextSlot;
        }
    } elseif ($card['type'] === 'value') {
        if ($moveType === 'place') {
            $sector = (string) ($move['sector'] ?? '');
            $color = (string) ($move['color'] ?? '');
            if (!isset($sectorLengths[$sector]) || !in_array($color, ['research', 'patient'], true)) {
                respond(['error' => 'Invalid piece placement'], 400);
            }
            $selectedColor = is_array($selectionRecord['value'] ?? null)
                ? ($selectionRecord['value']['outcomeColor'] ?? null) : null;
            if ($selectedColor !== $color) respond(['error' => 'Piece color does not match the selected outcome'], 409);
            $nextId = max(1, (int) ($board['nextId'] ?? 1));
            $board['pieces'][] = [
                'id' => $nextId,
                'team' => $team,
                'color' => $color,
                'sector' => $sector,
                'slot' => min($sectorLengths[$sector] - 1, max(0, $dieValue - 1)),
                'removed' => false,
            ];
            $board['nextId'] = $nextId + 1;
        } elseif ($moveType === 'forward') {
            $pieceId = filter_var($move['pieceId'] ?? null, FILTER_VALIDATE_INT);
            $destination = filter_var($move['destination'] ?? null, FILTER_VALIDATE_INT);
            if ($pieceId === false || $destination === false) respond(['error' => 'Invalid forward move'], 400);
            $pieceIndex = find_piece_index($board, $pieceId);
            if ($pieceIndex < 0 || !empty($board['pieces'][$pieceIndex]['removed'])) respond(['error' => 'Piece is unavailable'], 409);
            $piece = $board['pieces'][$pieceIndex];
            $sector = (string) ($piece['sector'] ?? '');
            $slot = (int) ($piece['slot'] ?? -1);
            if (!isset($sectorLengths[$sector])) respond(['error' => 'Piece sector is invalid'], 409);
            $aligned = aligned_indices_at($board, $sector, $slot);
            if (($piece['team'] ?? '') !== $team && count($aligned) === 0) {
                respond(['error' => 'Only your team or an aligned group may be moved'], 409);
            }
            $maxStep = count($aligned) > 0 ? $dieValue * 2 : $dieValue;
            if ($destination <= $slot || $destination > $slot + $maxStep || $destination >= $sectorLengths[$sector]) {
                respond(['error' => 'Destination is out of range'], 409);
            }
            if (count($aligned) > 0) {
                foreach ($aligned as $index) $board['pieces'][$index]['slot'] = $destination;
            } else {
                $board['pieces'][$pieceIndex]['slot'] = $destination;
            }
        } else {
            respond(['error' => 'Value rounds require a place or forward move'], 409);
        }
    } else {
        respond(['error' => 'Unknown environment card type'], 409);
    }

    if (!isset($dice['used']) || !is_array($dice['used'])) {
        $dice['used'] = array_fill(0, count($dice['rolls']), false);
    }
    $dice['used'][$dieIndex] = true;

    $boardResult = save_current_record($db, $boardKey, $boardRecord, $board);
    $diceResult = save_current_record($db, $diceKey, $diceRecord, $dice);
    $response = [
        'ok' => true,
        'actionId' => $actionId,
        'records' => [$boardKey => $boardResult, $diceKey => $diceResult],
    ];
    $log = $db->prepare('INSERT INTO action_log(action_id, room, response, created_at) VALUES(?, ?, ?, ?)');
    $log->execute([$actionId, $room, encode_value($response), now_ms()]);
    return $response;
}

try {
    $db = open_db();
    migrate_legacy_json($db);

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        if (isset($_GET['snapshot'])) {
            $room = strtoupper((string) $_GET['snapshot']);
            if (preg_match('/^[A-Z2-9]{4}$/', $room) !== 1) respond(['error' => 'Invalid room'], 400);
            $prefix = 'room_' . $room . '_';
            $stmt = $db->prepare(
                'SELECT key, version, value, updated_at FROM state_store WHERE substr(key, 1, ?) = ? ORDER BY key'
            );
            $stmt->execute([strlen($prefix), $prefix]);
            $records = [];
            foreach ($stmt->fetchAll() as $row) {
                $records[$row['key']] = [
                    'v' => (int) $row['version'],
                    'value' => decode_value($row['value']),
                    'updatedAt' => (int) $row['updated_at'],
                ];
            }
            respond(['records' => $records]);
        }

        if (!empty($_GET['list_rooms'])) {
            $stmt = $db->query("SELECT key, version, value, updated_at FROM state_store WHERE key GLOB 'room_*_cfg'");
            $rooms = [];
            foreach ($stmt->fetchAll() as $row) {
                if (preg_match('/^room_([A-Z2-9]{4})_cfg$/', $row['key'], $match) !== 1) continue;
                $code = $match[1];
                $prefix = 'room_' . $code . '_';
                $activity = $db->prepare('SELECT MAX(updated_at), COUNT(*) FROM state_store WHERE substr(key, 1, ?) = ?');
                $activity->execute([strlen($prefix), $prefix]);
                [$lastActivity, $fileCount] = $activity->fetch(PDO::FETCH_NUM);
                $cfg = decode_value($row['value']);
                $rooms[] = [
                    'code' => $code,
                    'created' => $cfg['ts'] ?? (int) $row['updated_at'],
                    'lastActivity' => (int) $lastActivity,
                    'tables' => $cfg['tables'] ?? [],
                    'fileCount' => (int) $fileCount,
                ];
            }
            usort($rooms, function ($a, $b) { return $b['lastActivity'] <=> $a['lastActivity']; });
            respond($rooms);
        }

        $key = $_GET['key'] ?? '';
        if (!valid_key($key)) respond(['error' => 'Invalid key'], 400);
        respond(get_record($db, $key));
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') respond(['error' => 'Method not allowed'], 405);
    $rawInput = file_get_contents('php://input');
    $input = json_decode($rawInput ?: '', true);
    if (!is_array($input) || json_last_error() !== JSON_ERROR_NONE) respond(['error' => 'Invalid JSON body'], 400);

    $action = $input['action'] ?? null;
    if ($action === null) {
        if (array_key_exists('append', $input)) $action = 'append';
        elseif (array_key_exists('merge_table', $input)) $action = 'merge_table';
        elseif (array_key_exists('value', $input)) $action = 'set';
    }

    if ($action === 'reset_prefix') {
        $prefix = (string) ($input['prefix'] ?? '');
        if (!valid_key($prefix) || strpos($prefix, 'room_') !== 0) respond(['error' => 'Invalid reset prefix'], 400);
        begin_immediate($db);
        try {
            $stmt = $db->prepare('DELETE FROM state_store WHERE substr(key, 1, ?) = ?');
            $stmt->execute([strlen($prefix), $prefix]);
            $deleted = $stmt->rowCount();
            if (preg_match('/^room_([A-Z2-9]{4})_/', $prefix, $match) === 1) {
                $log = $db->prepare('DELETE FROM action_log WHERE room = ?');
                $log->execute([$match[1]]);
            }
            $db->exec('COMMIT');
            respond(['ok' => true, 'deleted' => $deleted]);
        } catch (Throwable $e) {
            rollback_quietly($db);
            throw $e;
        }
    }

    begin_immediate($db);
    try {
        if ($action === 'set') {
            $key = require_key($input);
            if (!array_key_exists('value', $input)) respond(['error' => 'Missing value'], 400);
            $record = set_record($db, $key, $input['value'], $input['expectedVersion'] ?? null);
            if (!empty($record['conflict'])) {
                rollback_quietly($db);
                respond($record, 409);
            }
            $db->exec('COMMIT');
            respond(['ok' => true, 'key' => $key, 'record' => $record]);
        }

        if ($action === 'merge_field' || $action === 'merge_fields') {
            $key = require_key($input);
            $changes = $action === 'merge_field'
                ? [['path' => $input['path'] ?? null, 'value' => $input['value'] ?? null]]
                : ($input['changes'] ?? null);
            if (!is_array($changes)) respond(['error' => 'Missing field changes'], 400);
            $record = merge_fields_record($db, $key, $changes);
            $db->exec('COMMIT');
            respond(['ok' => true, 'key' => $key, 'record' => $record]);
        }

        if ($action === 'append') {
            $key = require_key($input);
            $item = array_key_exists('item', $input) ? $input['item'] : ($input['append'] ?? null);
            $result = append_record($db, $key, $item);
            $db->exec('COMMIT');
            respond(['ok' => true, 'key' => $key] + $result);
        }

        if ($action === 'merge_table') {
            $key = require_key($input);
            $tableKey = (string) ($input['tableKey'] ?? $input['merge_table'] ?? '');
            if (!valid_key($tableKey)) respond(['error' => 'Invalid table key'], 400);
            $record = merge_fields_record($db, $key, [[
                'path' => ['tables', $tableKey],
                'value' => ['display' => (string) ($input['display'] ?? $tableKey)],
            ]]);
            $db->exec('COMMIT');
            respond(['ok' => true, 'key' => $key, 'record' => $record]);
        }

        if ($action === 'batch') {
            $result = batch_operation($db, $input['operations'] ?? []);
            if (!empty($result['conflict'])) {
                rollback_quietly($db);
                respond($result, 409);
            }
            $db->exec('COMMIT');
            respond($result);
        }

        if ($action === 'apply_move') {
            $result = apply_move($db, $input);
            $db->exec('COMMIT');
            respond($result);
        }

        rollback_quietly($db);
        respond(['error' => 'Unknown action'], 400);
    } catch (Throwable $e) {
        rollback_quietly($db);
        throw $e;
    }
} catch (PDOException $e) {
    respond(['error' => 'Database error', 'detail' => $e->getMessage()], 500);
} catch (Throwable $e) {
    respond(['error' => 'Server error', 'detail' => $e->getMessage()], 500);
}
