# Daemon lifecycle learnings

## A runtime safeguard needs verification against the installed build

Bun 1.4.2 passes the reduced optimizer regression that crashes Bun 1.4.0. That
result did not establish that the live daemon was fixed: later crash reports
reached the same exception assertion through both the baseline JIT and the
interpreter. Disabling baseline, DFG, and FTL prevents those JIT tiers from
running; it does not prove that all native crashes are resolved. The settings
must be present before VM initialization, which is why the CLI re-executes.

The incident was reproduced in the native working-tree watcher's missing-directory
cleanup: it released JavaScript references on a worker thread and corrupted later
runtime operations. macOS now uses the built-in recursive file watcher. The runtime
upgrade and JIT guard alone could not fix that dependency's unsafe cleanup.

Verify the selected managed executable, its build revision, resolved published
SDKs, and native binding before testing a recovery. Reloading an older local
binary does not pick up fixes synced to main. A Node source launch also uses its
installed native addon, while a standalone build embeds the separately built
addon. These are different artifacts until their identities are checked.

Verify authenticated profile and project requests and the actual Desktop view,
then observe real session work. A health response or a short transport smoke
alone cannot establish recovery from an intermittent native crash. Preserve the
live database and reproduce against an isolated copy whenever possible.
