# Sync-layer rewrite

This game now uses a versioned SQLite store instead of one JSON file per key. Every read returns an envelope with `v`, `value`, and `updatedAt`; replacement writes use `expectedVersion`; field changes are merged atomically; and board moves update the board and the chosen die in one transaction.

## Deployment requirements

- PHP 8.1 or later with PDO SQLite enabled.
- Write permission for the directory containing the SQLite database.
- Deploy `sync.php`, `sync.js`, `index.html`, `moderator.html`, `board.html`, and `styles.css` together. Old browser code is not compatible with the version envelopes, so players and moderators must reload after deployment.
- Prefer setting `BC_DB_PATH` to a writable location outside the public web root. If it is not set, the database is created as `data/broadening_circles.sqlite`. The included Apache `.htaccess` blocks web access to `data`, but equivalent protection must be configured separately for Nginx or another server.

## Migration behavior

On the first request, `sync.php` imports valid `data/room_*.json` files into SQLite at version 1 and records a migration marker. Existing JSON files are left untouched as a backup and are not read again after the marker is written.

Before deployment, back up the whole game directory. Use a short maintenance window: allow in-flight games to finish, deploy all changed files together, make one request to `sync.php`, and verify that the SQLite database and its `-wal`/`-shm` companions can be created. A rollback to the old code restores the pre-migration JSON state only; activity written solely to SQLite after cutover will not appear in the old backend.

## Automated verification

From this directory, with Node.js and PHP on `PATH`, run:

```sh
node --test tests/*.test.js
```

The client suite covers stale-response rejection, conditional writes, conflict reapplication, expected versions, duplicate-action guards, snapshots, and atomic-move caching. The server suite starts a four-worker PHP test server against a temporary SQLite database and covers competing writes, simultaneous field merges, legacy-null upgrades, batch rollback, idempotent move retries, and stale moves after a phase change. If PHP is unavailable, only the server suite is skipped.

## Live device sign-off

Automated tests should be followed by one real round using a moderator, projector, and at least three player devices:

1. Submit team selections and moves from two devices at nearly the same time; confirm both changes remain.
2. Advance the round while a player submits a move; confirm the move either completes before the transition or is rejected, never partly applied.
3. Lock or disconnect one phone, make changes elsewhere, reconnect it, and confirm current state replaces its stale view.
4. Double-click actions and retry after a brief network interruption; confirm one move consumes one die exactly once.
5. Complete a normal round and confirm polling remains responsive and the moderator, player, and projector views agree.

## Operational notes

- SQLite runs in WAL mode with a five-second busy timeout.
- `reset_prefix` removes both room state and that room's idempotency log.
- The action log makes retried board moves safe after a lost response.
- Do not copy the live SQLite database without its WAL file while games are active. Use SQLite's backup mechanism or stop writes first.
