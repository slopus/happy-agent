# Project files — learnings

## Workspace transfers allow 50 MiB without raising relay storage limits

The previous 44 MiB file limit and 48 MiB HTTP JSON limit could not carry a 50 MiB attachment.
Workspace reads and writes now allow 50 MiB, and only file-write requests receive a 72 MiB JSON
envelope for base64 expansion. Smaller callers keep their own byte bounds. Happy attachment blob
storage keeps its existing limit; remote workspace requests use Tailcat, which may relay encrypted
bytes through DERP when direct UDP is unavailable.

## Smaller transports reuse the existing read methods

Separate bounded-reader siblings duplicated the file API unnecessarily. `read` now accepts an
optional byte limit and shares one regular-file, contained, bounded stream with every caller.
It checks size before reading and reads at most one extra byte to detect growth. `readRevision`
accepts the same limit through options; strict callers preserve failures while the default keeps
the HTTP preview's nullable result. Absolute native file links are normalized only within the
selected root; the HTTP request schema still requires relative paths.

## Binary filenames in plain folders, ancestor ignore rules in nested folders

FFF 0.9.6 left binary-extension filenames (`.bin`, `.png`, …) out of every folder that is in no
Git repository, so a plain-folder project could not `@`-mention its images or data files. FFF
0.10 and later index them, but their walker loses the ignore rules an ancestor repository
declares when it indexes a subfolder, so `node_modules`, build output and ignored logs leaked into
autocomplete; an earlier 0.10.6 upgrade was reverted for that. The module now uses FFF 0.11 for a
repository's top level and for a folder in no repository, and lists a folder nested below its
repository's top level with Git's own ignore-aware `ls-files`, ranked by `rankFilePaths` as runner
folders are. Whether a folder is nested is FFF's own answer (`healthCheckStatic`), not Git's: Git
honours `GIT_CEILING_DIRECTORIES` and libgit2 does not, so asking Git missed folders FFF still
indexed in an enclosing checkout's mode. A folder Git lists nothing for, because its repository
ignores it entirely (as the checkout ignores the gym's `.local` scratch, which is how Linux CI
caught `node_modules` leaking) or because Git is told not to look above it, keeps FFF's index with
results under dependency directories left out, the same set FFF leaves out of a plain folder.
Git's listing is bounded at 20,000 paths, and a folder that reaches the cap is indexed by FFF the
same way, because ranking a cut-off listing silently lost every later file. The listing also
subtracts `ls-files --deleted`: the index keeps a tracked file removed from disk, which search must
not suggest. Tests prove each behavior. FFF 0.11 also ships one bundled entry, so the standalone
binary build rewrites the library resolver inside `dist/index.js`, and the release smoke proves file
search loaded the embedded library. Plain-folder fixtures must live outside any checkout: libgit2
ignores `GIT_CEILING_DIRECTORIES`, so an enclosing checkout silently switches FFF into its
Git mode and hides the plain-folder behavior. The gym's default scratch folder sits inside this
checkout, which is how the binary omission stayed invisible to gym runs that did not set
`HAPPY_AGENT_GYM_SCRATCH_DIRECTORY` elsewhere. FFF 0.11 also ranks differently from 0.9.6; exact
orders in tests are FFF's, not an API contract.

## Native search starts only when it is needed

Loading the FFF native binding while composing the daemon put optional file indexing on the
workspace-startup critical path. The module imports FFF lazily on the first search request. Later
requests reuse the loaded binding and a bounded set of workspace indexes. A search waits at most
100 milliseconds for an active scan and then uses the live partial index.

## The index rescans on events, not on age

Running FFF's watcher and also rescanning any index older than two seconds walked whole trees on
nearly every search, and every file create or rename triggered another full walk. FFF's watcher is
now disabled; the index subscribes to the Git module's shared working-tree watch, which already
excludes ignored directories, and is marked stale only when a path is created or deleted. An idle
workspace is never rescanned. The two-second age rule survives only for a tree that cannot be
watched.

## A rendered file is watched by itself

On macOS, libuv serves every directory `fs.watch` in a process from one FSEvents stream, and
stops and recreates it from "now" whenever any directory watch is added or closed anywhere in the
daemon. A change landing during that gap is never reported: with other directory watches opening
and closing, a write right after arming was missed about three times in four. A rendered file
was watched only through its directory, so it could stay stale until its next change. A file
watch is a kqueue vnode watch there and is not affected, so each rendered file now has its own,
with a fingerprint taken before its bytes to cover the gap before it arms. Modification time and
size alone miss a same-size write that restores the time, so the fingerprint includes the inode
and change time. An atomic replace leaves the watch on the old inode after one rename event; the
new file is watched afresh.

Directory watches carry tree-page structure, and their creates and deletes were lost the same way:
a create landing a few milliseconds before or after another folder was opened went unreported
about one time in ten on Bun and Node alike, which made `files.updated` time out intermittently in
the files chaos gym. Each directory watch now keeps the folder's entry names and its
directory fingerprint (device, inode, modification and change times) from when it armed. Right
after any directory watch is added or closed, every watched folder whose fingerprint moved is
compared with its entries and the difference reported; a folder is compared again when a client
reads it again. That is the churn itself and the client's next look, not a timer, so nothing
polls. A reported change is folded into the entries on the next turn so it is not reported twice.
A folder of more than 1,000 entries is reported as a whole change rather than compared by name.

Review found three gaps in that first version. On macOS `fs.watch` returns before the kernel
holds the kqueue watch, which happens at the loop's next poll; a write right after the comparison
was missed every time, so the comparison now waits two loop turns, which from an I/O callback is
the first check after that poll. A re-read of the same path kept a live watch even when the path
now named another file, as after its folder was moved and made again, so a watch is kept only for
the same device and inode. And macOS reports a write in place as a rename, which closed and
re-armed the watch and forced a full rescan of the index; a rename that leaves the same file at
the path is now an ordinary change.

## A direct read during a scan still asks for one

A read that proves a file exists asks the index to rescan when the file is missing from it. The
read used to drop that request while a scan was in flight, but the scan may have passed the folder
before the file was created, and nothing else marked the index stale until the watch reported the
change. On a loaded machine that took longer than the file search waited, so the file stayed
missing. The read now marks the index stale during a scan, and any stale index rescans on the
next search, whether or not its tree is watched.

## FFF statuses whatever repository encloses the folder

FFF finds a folder's repository with libgit2, which ignores `GIT_CEILING_DIRECTORIES`. A folder
without its own `.git` inside a checkout is indexed with that checkout's ignore rules, and every
scan ends with a `git status` of the whole checkout. FFF clears its scanning flag when the walk
lands but refuses a new walk until that status finishes, so a rescan asked for in the meantime
waits behind it while `isScanning()` reports false. Test workspaces under a `TMPDIR` inside a
large checkout missed files for seconds this way. They are now repositories of their own, as real
workspaces are.

## File trees must not wait for autocomplete indexing

Using FFF's ignore set to filter tree branches made valid physical folders disappear and forced a
one-level tree request to await a workspace-wide scan. Tree pages now read only the requested
physical directory and return ignored folders such as `node_modules` immediately. FFF remains the
right boundary for ranked autocomplete, where ignoring dependency trees prevents expensive and
noisy suggestions.

## Watch only what the client rendered

A recursive second watcher would recreate the dependency-tree cost that FFF removed. File reads
and tree pages instead arm non-recursive watches only for their containing directories, retained
in a bounded least-recently-used set. External changes and successful API writes are debounced into
bounded path invalidations so clients can refresh visible state without file contents entering the
event journal.

## Search belongs to the selected physical workspace

The API resolves a project or child-workspace resource through `ProjectFilesModule` first. The
index uses that canonical root without deriving another path, so a child workspace searches and
lists its own checkout rather than the root project's files.

## Viewer access is not a model permission boundary

The project-files API is an authenticated client surface for browsing, previewing and occasional
human edits. Every valid path inside the selected root is available there, including `.git`,
`AGENTS.md` and `AGENTS_SECURITY.md`; traversal and symlink escapes remain forbidden. Restrictions
on model writes belong to the compute sandbox and its host policy, not to the file viewer.

## Runner folders use the same calls, not a second implementation

Folders on runners need the file viewer too. Rather than a runner-specific copy of every read and
write, all filesystem work now goes through the folder's machine compute: this machine's when no
runner is named, the runner's otherwise. The O_NOFOLLOW open and the device/inode identity check
became `readFileBuffer` with `noFollow`, preceded by a regular-file check and followed by a fresh
resolution that must land on the same path. Replaced files keep their permission bits and new files
get the machine's default mode, instead of both inheriting the temporary file's `0600`. Only search and watching differ, because FFF and
non-recursive native watches read this machine's disk: runner folders are listed and watched by the
runner itself.

A runner folder's Git listing stops at 20,000 paths, and ranking that cut-off list silently lost
every later file. When the listing is truncated, a search with a query now asks Git for only the
paths holding the query's letters in order (a case-insensitive `ls-files` pathspec, with glob
characters escaped) and ranks those, so a file past the cap is found without listing everything.

## The native index and watches are only for the daemon's own user

The FFF index and the native watcher read folders in the daemon's process, as the daemon's user.
When `[execution]` runs work as a separate Linux user, those folders belong to that user and the
daemon may not be able to read them, and reading them as the daemon would bypass the separation.
The native paths are taken only when `RunnersModule.native(runnerId)` says so; otherwise browsing,
indexing, and watching go through the default workload user's runner, like a runner's folders.
