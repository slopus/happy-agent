# Optimize Happy Agent performance

Use this recipe when the user says Happy is slow. It records what was hard to learn on a real
loaded host: where the time actually goes, which measurements separate the causes quickly, and
which SQLite changes help or don't. Numbers below are only examples for scale. Measure on the
host you are fixing. Execute the recipe end to end, as the [recipe rules](README.md) describe.

## 1. Find which disk holds what

Don't assume the database and the workspaces share a disk. Check each path with `df <path>` or
`findmnt -T <path>`:

- the daemon's SQLite: `~/.happy/agent/agent.sqlite`, `auto-agent.sqlite`, and their `-wal` files;
- project Git object stores;
- workspaces under the Happy home, with their worktrees, `target/`, and `.context/` folders.

A first diagnosis once blamed the database for a slow disk that held only the workspaces.

## 2. Measure before changing anything

- **Sync-write probe on each mount.** `dd if=/dev/zero of=<dir>/probe bs=4k count=50
oflag=dsync`, then delete the probe file. It takes seconds and separates a healthy NVMe (about
  2–5 ms per write) from a saturated drive (hundreds of ms).
- **Disk load.** The `full` line of `/proc/pressure/io`, `iostat -x` (`%util`, `w_await`,
  `aqu-sz`), and `/proc/diskstats`.
- **Full DRAM-less QLC drives are the classic trap.** Past roughly 70–80% full the SLC cache
  collapses, and the drive shows almost 100% busy while writing only 10–15 MB/s. Freeing space
  helps more than any tuning.
- **Who writes.** Sample `write_bytes` in `/proc/<pid>/io` for candidate processes over a minute.
- **Daemon or desktop.** Time a trivial request to the local daemon many times, for example
  `curl -o /dev/null -w '%{time_total}\n' --unix-socket ~/.happy/agent/server.sock
http://localhost/v0/health` (a team daemon's TCP port works too; a 401 is fine). A good p50 with
  a bad p95 means event-loop stalls, not the network or the desktop.
- **Event-loop stalls without `perf`.** `perf` is often blocked (`perf_event_paranoid=3`). Sample
  field 14 (`utime`) of `/proc/<pid>/task/<pid>/stat`, the main thread, every 10 ms. Long unbroken
  runs on CPU are JavaScript or SQLite work on the event loop; long gaps while requests are slow
  are I/O waits.
- **Slow module hooks.** Hooks that take 250 ms or more are logged at debug level as
  `module:hook:slow module=<name> hook=<hook> durationMs=<n>` in `~/.happy/agent/observation/agent.log`.
  The default level is `info`, so start the daemon with `HAPPY_OBSERVATION_LOG_LEVEL=debug` or set
  `log_level = "debug"` under `[observation]`. Typical offenders are `permissions` `beforeToolCall`,
  `skills` `instructions`, and `slash-commands` `beforeTurn`. They scan workspace folders, so on a
  saturated workspace disk fix the disk first.

## 3. SQLite

The daemon opens `agent.sqlite` and `auto-agent.sqlite` with `openHappyAgentDatabase` in
`packages/happy-agent-modules/sources/runtime/HappyAgentDatabase.ts`; artifact data has its own
stores in `artifactData/impl/`. Pragmas live in `configure()` there, not in `happy-agent-base`'s
`openAgentSQLiteDatabase`: the daemon uses the published `@slopus/happy-agent-base`, which needs
human approval to change. Read the current pragmas and the runtime `LEARNINGS.md` before
proposing changes.

- **`synchronous` in WAL mode.** `FULL` waits for an fsync on every commit, on the event loop,
  and a turn makes on the order of a hundred commits. `NORMAL` loses nothing on a daemon crash; an
  OS crash or power loss can lose the last commits since a sync, but never corrupts the database.
  For scale: a 30-turn gym run took 13.5 s at all-`FULL` and 7.3 s at all-`NORMAL`.
- **Make only the writes that matter durable.** The WAL is append-only, so a crash loses a suffix
  of commits, and one `FULL` commit makes every earlier commit durable too. Place one `FULL` commit
  just before the daemon acts outside itself, and a crash can lose at most what happened since the
  last tool dispatch or acknowledged message. To choose:
    1. Count commits by table and call site at the libSQL client during a gym run.
    2. Classify each write: (a) rebuilt or retried with no visible harm; (b) the user loses input or
       a decision; (c) an exactly-once guarantee breaks.
    3. Make only (b) and (c) `FULL`. Typical (c): the tool batch record before tools run, outbox
       rows before sending, rotated refresh and OAuth tokens, delivery counters, remote cursors, and
       idempotency keys stored before external work. Typical (b): a person's message before it is
       acknowledged, settings, secrets, answers to questions, create, archive, or rename actions,
       direct Surface edits (todos, calendar events, documents), and artifact app writes.
       The event journal (the largest share), inference bookkeeping, usage, caches, compactions,
       auto-review evidence, and `auto-agent.sqlite` are safe as `NORMAL`.

    With about 5% of commits `FULL`, the run took 7.7 s.

- **You cannot pick `FULL` at `BEGIN`.** SQLite refuses to change `synchronous` inside a
  transaction, and the code that knows a write matters usually runs inside a transaction someone
  else opened. Mark the transaction instead (`requireDurableCommit(ctx)`), and after it commits,
  still in the database queue, commit a no-op such as rewriting the unchanged `user_version` at
  `FULL`. That costs one WAL fsync.
- **A `FULL` commit syncs only its own database file.** Separate SQLite files, such as the
  artifact data stores, need their own barrier or should stay `FULL`. Mark durability where the
  change is made, so direct API paths are covered, not only tool paths.
- **Recovery reruns durable and reloadable tools.** An idempotency key that guards an effect
  outside the database, such as a folder, clone, or workspace, must itself be durable
  (`getOrCreateDurably`), or the rerun repeats the effect under a new ID.
- **Pragmas are per connection.** The libSQL client pool opens a fresh connection for any call
  that overlaps another, with default pragmas (`cache_size=-2000`, `foreign_keys=0`). The daemon
  serializes every call through one queue; use `concurrency: 1` on the client so settings always
  apply. Benchmarks and scripts must serialize too, or their numbers are wrong.
- **`cache_size` helps only when it holds the hot working set.** Size it from measurement. For
  scale: with a working set near 70 MB, 64 MB was no better than the default, 128 MB cut hot
  rereads about 4×, and 256 MB added nothing.
- **No-ops in this libSQL build:** `mmap_size` (maps at most about 2 GiB and helped no more than
  the cache) and `temp_store` (already in memory).
- **Never back up or snapshot the live `agent.sqlite` on a loaded host** to benchmark against it,
  with the backup API or `VACUUM INTO`. The long read snapshot blocks checkpoints; once the WAL
  grew from 77 MB to 1.5 GB in half an hour and stayed there until restart. Use gym runs, which
  start with a fresh database. They show commit-path effects but not cache effects on large data.
- **What pragmas don't fix.** Cold reads are bound by the disk. Loading history is dominated by
  `JSON.parse` of every record of the agent. `readHistoryStats` in the history module sums columns
  stored after `message_json`, so it reads every message body (about 1 s cold for a large agent).
  These need code changes.

## 4. Benchmark

- Use a gym scenario with the daemon in process, such as 30 turns of 5 `exec_command` calls each.
  Alternate baseline and candidate runs, at least 4 of each. Record total time, turn p50 and p95,
  tool-step p50, and event-loop lag p99 and max.
- `packages/happy-agent-gym/perf/` has ready benchmarks for restart, desktop bootstrap, and opening
  long sessions (`ciBench.ts` and `ciCompare.ts`).
- Run on a fast disk or tmpfs. On a saturated disk, tests and gyms time out and the noise swamps
  the effect.

## 5. Workspace disk writers

Agent work in the workspaces is often the real load. Seen in Rust and Postgres projects:

- **Postgres test churn.** Tests that `CREATE DATABASE` and migrate per test without dropping, and
  agents starting a new Postgres cluster per run under `.context/`, were the largest writers. Use
  one cluster on `/dev/shm`, a template database migrated once, a drop after each test, and a
  rule in the project's `AGENTS.md`.
- **Cargo link output.** Every `tests/*.rs` file links its own binary (hundreds of MB each).
  Merging them into one test binary per crate cut link writes about 10×. `target/` folders are
  the main space hog and can always be regenerated.
- **Workspace removal that keeps failing.** `git worktree remove` deletes `.git` first, then fails
  on read-only Go module caches in `.context/`, so every retry reports "not a git repository".
  Make the tree writable before removing it, and set `GOFLAGS=-modcacherw` for agents.

## 6. Report

Report which disk holds what, the probe and load numbers, the causes found, what was changed, and
before-and-after measurements from alternating runs.
