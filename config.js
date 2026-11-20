// Local/PHP deployments need no configuration: sync.js falls back to sync.php.
// The GitHub Pages workflow replaces this file in its deployment artifact with
// the public Cloudflare Worker URL stored in the BC_SYNC_URL repository variable.
window.BC_SYNC_URL = window.BC_SYNC_URL || '';
