# Free hosted deployment

The repository retains two complete deployment paths:

- **PHP/SQLite:** the original edition in the repository root, using `sync.php`.
- **GitHub Pages + Cloudflare:** the same browser interface hosted by GitHub Pages, using the Worker/D1 API under `cloudflare/`.

GitHub Pages cannot execute PHP, so the hosted edition uses Cloudflare Workers and D1 for its synchronization API. Local and traditional PHP hosting continue to fall back to `sync.php` because `config.js` leaves `BC_SYNC_URL` empty.

## One-time Cloudflare setup

1. Create or sign in to a Cloudflare account with the Workers Free plan.
2. Install dependencies:

   ```sh
   cd cloudflare
   npm install
   ```

3. Authenticate Wrangler:

   ```sh
   npx wrangler login
   ```

4. Create the database:

   ```sh
   npx wrangler d1 create broadening-circles
   ```

5. Replace the placeholder `database_id` in `cloudflare/wrangler.jsonc` with the ID printed by Wrangler.
6. Apply the schema and deploy:

   ```sh
   npm run db:migrate:remote
   npm run deploy
   ```

7. Copy the HTTPS `workers.dev` URL printed by Wrangler.

## One-time GitHub setup

1. Push the repository to GitHub.
2. In the repository, open **Settings > Secrets and variables > Actions > Variables**.
3. Create a repository variable named `BC_SYNC_URL` whose value is the deployed Worker URL, without a trailing slash.
4. Open **Settings > Pages** and select **GitHub Actions** as the source.
5. Run the **Deploy GitHub Pages** workflow, or push another commit to `main`.

The public URLs will be:

- Player: `https://floydstott.github.io/broadening-circles-zoom/`
- Moderator: `https://floydstott.github.io/broadening-circles-zoom/moderator.html`
- Projector: opened from the moderator screen after a room is created.

## Updating the hosted game

Changes pushed to `main` automatically rebuild and deploy the GitHub Pages interface. Worker changes require `npm run deploy` from `cloudflare/` unless a separate authenticated Worker deployment workflow is added later.

## Security and operating limits

- The hosted game is public and intentionally has no account system.
- Anyone who knows a room code can join; anyone who discovers the moderator URL can create or load rooms.
- Use new room codes for each workshop and share links only with participants.
- Cloudflare's free usage limits are suitable for workshop-scale play, not a large public service.
- The Cloudflare database starts empty. The PHP edition's legacy JSON migration remains available only in `sync.php`.
