# Broadening Circles

Broadening Circles is a browser-based, team facilitation game for exploring how research partnerships create impact. Participants join one of three perspectives - Research-Centered, Patient-Centered, or Balanced - then select resources and outcomes, respond to environment cards, roll dice, and move shared pieces around the impact board.

The project is designed for an in-person or video-conference workshop. It provides separate views for players, the moderator, and a shared projector or screen-share display.

## Main features

- Three collaborative teams with shared hands, selections, dice, and board state.
- Moderator-controlled rounds, timers, environment cards, and team order.
- A projector view for a shared display or Zoom screen share.
- Versioned SQLite synchronization with conditional writes and stale-response rejection.
- Atomic field updates and transactional board moves that protect simultaneous actions.
- Automatic migration of legacy `data/room_*.json` room files on first startup.
- Automated client and server concurrency tests.
- Two retained deployment paths: PHP/SQLite or GitHub Pages with Cloudflare Workers/D1.

## Requirements

- PHP 8.1 or newer.
- PDO SQLite enabled in PHP.
- A writable database directory.
- A modern browser with JavaScript enabled.
- Node.js 20 or newer only if you want to run the automated tests.

## Quick start

From the project directory, start PHP's development server:

```sh
php -S 127.0.0.1:8000
```

Open the following pages:

- Moderator: `http://127.0.0.1:8000/moderator.html`
- Players: `http://127.0.0.1:8000/index.html`
- Projector: open it from the moderator screen after creating or loading a room.

The moderator creates a room and shares its four-character code. Players enter the code, provide a unique display name, and choose a team. The game can begin after every team has at least one participant.

## Using phones or other computers on the same network

Bind the development server to the network instead of localhost:

```sh
php -S 0.0.0.0:8000
```

Share `http://YOUR-COMPUTER-IP:8000/index.html` with players on the same trusted Wi-Fi network. Keep the host computer awake and allow incoming connections if its firewall asks.

PHP's development server is intended for local testing. Do not expose it directly to the public internet. Remote workshops should use a proper PHP host with HTTPS.

## Game flow

1. The moderator creates a room.
2. Participants join one of the three teams.
3. The moderator starts the game and reveals an environment card.
4. Teams select a resource and an outcome during the preparation period.
5. The moderator ends preparation, assigns any extra die, and rolls for all teams.
6. Teams use their dice to place or move pieces on the shared board.
7. The moderator advances to the next round until the environment deck is complete.

Multiple people may join the same team. They share that team's controls, so the latest teammate selection becomes the team's current selection. Server-side transactions prevent the same die from being consumed twice and ensure board and die changes commit together.

## Synchronization architecture

`sync.php` is the authoritative state service. It stores one SQLite row per state key with a version number, JSON value, and update timestamp. Clients send their expected version for replacement writes; stale writes receive a conflict response instead of silently overwriting newer state.

Shared fields use atomic merge operations. Board moves are validated and committed on the server in the same transaction as die consumption. Action identifiers make a retried move safe after a lost network response. Polling clients keep the highest version observed for each key and discard older responses.

See [Sync architecture and deployment](docs/SYNC_ARCHITECTURE.md) for migration, rollback, operational, and live-device testing guidance.

For a no-cost public deployment, see [GitHub Pages and Cloudflare hosting](docs/FREE_HOSTING.md). This keeps the PHP version intact while adding a Pages-compatible synchronization backend.

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html` | Player interface |
| `moderator.html` | Moderator interface |
| `board.html` | Projector/shared-board interface |
| `board.js` | Board rules and SVG rendering |
| `cards.js` | Teams, resources, outcomes, and environment cards |
| `sync.js` | Browser synchronization and conflict handling |
| `sync.php` | SQLite API and transactional game actions |
| `styles.css` | Shared visual styling |
| `tests/` | Client and PHP/SQLite concurrency tests |
| `data/` | Default SQLite location and Apache access protection |
| `cloudflare/` | Worker/D1 backend for the GitHub Pages edition |
| `.github/workflows/pages.yml` | Automatic GitHub Pages deployment |

## Testing

With PHP and Node.js available on `PATH`, run:

```sh
node --test tests/*.test.js
```

The tests cover conditional writes, conflict recovery, stale polling responses, simultaneous field merges, transactional batch rollback, duplicate move retries, and moves submitted after a moderator changes the phase.

Before a production workshop, also complete the multi-device checklist in [the synchronization guide](docs/SYNC_ARCHITECTURE.md#live-device-sign-off).

## Deployment notes

- Deploy the HTML, JavaScript, CSS, and PHP files together; older clients are not compatible with the versioned response format.
- Set `BC_DB_PATH` to a writable location outside the public web root when possible.
- If `BC_DB_PATH` is not set, the database is stored at `data/broadening_circles.sqlite`.
- The included `data/.htaccess` blocks access on Apache. Configure equivalent protection when using Nginx or another server.
- Room state contains participant display names. Do not commit live room JSON or SQLite files to source control.

## Current limitations

- There is no user authentication or moderator password.
- Anyone who knows a room code can join the room.
- Team members intentionally share controls rather than receiving individual hands or dice.
- SQLite is appropriate for workshop-scale use, not a large public game service.

