# API black-box coverage ledger

This is the ownership ledger for master plan 22. A method, path, event family, or
removed route appears in exactly one lane. The lane test must prove the public
response, stable failure code, ordered events, version and mutation behavior,
real effect, and restart expectation where those concepts apply.

Direct human direction resolves the contract gates: projects are root
workspaces; projects and workspaces each embed an ordered top-level-agent
series; there is no global agent-list endpoint; workspace hierarchy is only
file hierarchy; and only user steering emits `run.boundary`. `API.md` is not
changed by the gym.

| Lane / test                                                     | Client methods and public paths owned                                                                                                                                                                                                                                                         | Events and required proof                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform — `happy_api_platform.test.ts`                         | `getGreeting`, `getHealth`, `getConfig`, `patchConfig`, `getInstructions`, `putInstructions`, `getSecurityPolicy`, `putSecurityPolicy`, `startInspector`, `stopInspector`, `shutdown`; `/`, `/v0/health`, `/v0/config`, `/v0/instructions`, `/v0/security`, `/v0/inspector/*`, `/v0/shutdown` | `config.updated`; token and socket permissions, starting/ready lifecycle, malformed and oversized bodies, secret/path redaction, restart persistence, graceful shutdown                                                                                                                                                                           |
| Environment — `happy_api_environment.test.ts`                   | `getProfile`, `updateProfile`, `getProfilePhoto`, `setProfilePhoto`, `deleteProfilePhoto`, `getOnboarding`, `completeOnboarding`, `getUsage`; `/v0/profile*`, `/v0/onboarding*`, `/v0/usage`                                                                                                  | `profile.updated`; ETag and `If-Match`, normalized media, onboarding persistence, empty and populated rolling usage                                                                                                                                                                                                                               |
| Happy integration — `happy_api_happy_integration.test.ts`       | `getHappyIntegration`, `startHappyIntegration`, `cancelHappyIntegration`, `disconnectHappyIntegration`, `rePairHappyIntegration`; `/v0/integrations/happy`, `/v0/integrations/happy/start`, `/v0/integrations/happy/cancel`, `/v0/integrations/happy/re-pair`                                 | `happy.integration.updated`; QR publication and expiry, unavailable and malformed authorization, concurrent joining, cancel/unlink/re-pair idempotence, successful connection and existing-agent attachment, restart ordering and server affinity, rejection suppression and changed-login recovery, socket-auth revalidation, disabled isolation |
| Projects — `happy_api_projects.test.ts`                         | `listProjects`, `registerProject`, `cloneProject`, `getProject`, `renameProject`, `replaceProjectSettings`, `refreshProject`, `reorderProject`, `archiveProject`, `getProjectAvatar`, `setProjectAvatar`, `deleteProjectAvatar`; `/v0/projects*`                                              | `project.created`, `project.updated`, mirrored root `workspace.created` and `workspace.updated`; client IDs, plain directories, hermetic clone, failed initialization, ordering, archive/revive, avatars, version chains, mutation echoes, restart                                                                                                |
| Workspaces — `happy_api_workspaces.test.ts`                     | `listWorkspaces`, `createWorkspace`, `getWorkspace`, `renameWorkspace`, `archiveWorkspace`, `reorderWorkspace`; `/v0/workspaces` and resource routes excluding files, Git, terminals, and proxy                                                                                               | `workspace.created`, `workspace.updated`; root identity, nested Git/copy hierarchy, sibling order, invalid parent/base, failed initialization, archive cascade and cleanup failure, restart                                                                                                                                                       |
| Files and Git — `happy_api_files_git.test.ts`                   | `searchFiles`, `getFileTree`, `readFile`, `writeFile`, `readFileRevision`, `getWorkspaceGit`, `watchGit`; workspace `/files*`, `/git`, `/v0/git/watch`                                                                                                                                        | `files.updated`, `git.updated`; physical-tree paging, indexed search, rendered-path invalidation, binary reads, CAS and current hash, traversal and symlink confinement, size limits, revisions, staged/unstaged/untracked/binary/conflict state, watch replacement and continued usability                                                       |
| Terminals and proxy — `happy_api_terminal_proxy.test.ts`        | `listTerminals`, `openTerminal`, `resizeTerminal`, `stopTerminal`, `terminalAttachUrl`, `workspaceProxyUrl`; workspace `/terminals*`, terminal WebSocket upgrade, workspace `CONNECT /proxy`                                                                                                  | `terminal.created`, `terminal.updated`; PTY bytes, resize, replay, multi-attach, limits, protocol/auth failures, project-root and child tunnels, absolute HTTP, nested CONNECT, half-close, unreachable targets, teardown                                                                                                                         |
| Agent catalogs — `happy_api_agent_catalog.test.ts`              | `createAgent`, `getAgent`, `markAgentRead`, `archiveAgent`, `unarchiveAgent`, `reorderAgent`, `saveAgentDraft`; `POST /v0/agents`, agent resource/read/archive/order/draft routes, and embedded project/workspace agent arrays                                                                | `agent.created`, `agent.updated`; project/workspace scoped order, archive visibility, draft last-write-wins, read/unread, title and last mode, client-ID replay, subagent read-only conflicts, no global list                                                                                                                                     |
| Transcript and runs — `happy_api_transcript_runs.test.ts`       | `sendMessage`, `getMessages`, `abortAgent`, `compactAgent`, `getAgentUsage`; agent send/messages/abort/compact/usage routes                                                                                                                                                                   | `message.created`, `message.updated`, `message.delta`, `message.deleted`, `run.started`, `run.boundary`, `run.finished`; queue acceptance, multiple steering IDs, steering-only boundary, guarded abort, explicit/automatic compaction without boundary, whole-run paging, presentations, usage, recovery and restart                             |
| Questions and activity — `happy_api_questions_activity.test.ts` | `getPendingQuestion`, `answerQuestion`, `getAgentActivity`, `stopProcess`; question, activity, and process routes                                                                                                                                                                             | `question.created`, `question.updated`, `process.started`, `process.updated`, `process.exited`; first-write-wins answers, cancellation/autoresolution, subagent activity, process lifetime, stop idempotence, archive/daemon cleanup                                                                                                              |
| Sync and concurrency — `happy_api_sync_concurrency.test.ts`     | `getEvents`, `streamEvents`, `getDesktopBootstrap`; `/v0/events`, `/v0/events/stream`, `/v0/bootstrap/desktop`                                                                                                                                                                                | Every event envelope; pull `after`/inclusive `until`/limit, SSE hello/resume/gap, strict ordering, reconnect, bounded readers, bootstrap race, mutation echo, UUIDv7 version chains, two-client conflicts, durable restart                                                                                                                        |
| Contract closure — `happy_api_contract.test.ts`                 | Raw probes only for wrong/missing auth, unsupported media/methods, unknown paths, and removed legacy paths                                                                                                                                                                                    | Stable error shape/code, no unintended events/effects, following valid request succeeds, and a checked assertion that every ledger row has passing evidence                                                                                                                                                                                       |

Removed routes owned only by contract closure include `/v0/sessions*`,
`/v0/models`, `/v0/catalog`, `/v0/timeline`, `/v0/events/live`,
`/v0/events/trim`, `/v0/provider-usage`, legacy plural profile/sharing/secrets
surfaces, project-nested workspace/terminal/file/Git paths, and all other
pre-migration compatibility endpoints.

Every lane also owns the success and failure variants of its methods. Reusing a
`mutationId` must never deduplicate. A failed mutation must have no event or
effect and must leave the same client usable. No lane may import daemon modules,
stores, schemas, databases, or another lane's test implementation.

## Named scenario budget

The original files are fast smoke lanes. Matrix and chaos files add distinct
state, boundary, race, interruption, and recovery cases. These are minimum
runnable passing counts, not aspirations:

| Area                   |  Smoke | Exclusive matrix files and minimum new tests                                                                      | Final minimum |
| ---------------------- | -----: | ----------------------------------------------------------------------------------------------------------------- | ------------: |
| Platform               |      8 | `happy_api_platform_matrix.test.ts` — 30                                                                          |            38 |
| Environment            |      4 | `happy_api_environment_profile_matrix.test.ts` — 14; `happy_api_environment_onboarding_usage_matrix.test.ts` — 12 |            30 |
| Happy integration      |      8 | —                                                                                                                 |             8 |
| Projects               |      6 | `happy_api_projects_lifecycle_matrix.test.ts` — 22; `happy_api_projects_mutations_media_matrix.test.ts` — 20      |            48 |
| Workspaces             |      4 | `happy_api_workspaces_tree_matrix.test.ts` — 22; `happy_api_workspaces_lifecycle_matrix.test.ts` — 22             |            48 |
| Files and Git          |      2 | `happy_api_files_matrix.test.ts` — 25; `happy_api_git_matrix.test.ts` — 28                                        |            55 |
| Terminals and proxy    |      4 | `happy_api_terminal_matrix.test.ts` — 23; `happy_api_proxy_matrix.test.ts` — 18                                   |            45 |
| Agent catalogs         |      3 | `happy_api_agent_ownership_matrix.test.ts` — 22; `happy_api_agent_state_subagents_matrix.test.ts` — 20            |            45 |
| Transcript and runs    |      4 | `happy_api_messages_history_matrix.test.ts` — 26; `happy_api_run_boundaries_matrix.test.ts` — 25                  |            55 |
| Questions and activity |      4 | `happy_api_questions_matrix.test.ts` — 18; `happy_api_activity_process_matrix.test.ts` — 18                       |            40 |
| Sync and concurrency   |      6 | `happy_api_events_transport_matrix.test.ts` — 25; `happy_api_sync_races_bootstrap_matrix.test.ts` — 24            |            55 |
| Contract closure       |      5 | `happy_api_contract_matrix.test.ts` — 40                                                                          |            45 |
| Deterministic chaos    |      0 | Six chaos files below — 120                                                                                       |           120 |
| **Total**              | **58** | **566**                                                                                                           |       **624** |

The count retains a 28-scenario safety margin above the mandatory 596. A
collector count lower than 596 still fails even if this allocation table later
changes. Skips, TODOs, retries, expected failures, and platform exclusions
count as zero.

The chaos ownership is exclusive:

| Test file                          | Stable seeds | Actions per seed | Tests |
| ---------------------------------- | ------------ | ---------------- | ----: |
| `happy_api_chaos_catalog.test.ts`  | `C000-C023`  | 80               |    24 |
| `happy_api_chaos_files.test.ts`    | `F000-F015`  | 80               |    16 |
| `happy_api_chaos_runs.test.ts`     | `R000-R019`  | 60               |    20 |
| `happy_api_chaos_runtime.test.ts`  | `T000-T011`  | 40               |    12 |
| `happy_api_chaos_sync.test.ts`     | `S000-S027`  | 120              |    28 |
| `happy_api_chaos_recovery.test.ts` | `X000-X019`  | 70               |    20 |

Each named matrix row must exercise a distinct state/value pair or
interruption phase. Required partitions include current, missing, malformed,
and stale guards; fresh, replayed, and conflicting client IDs; first, middle,
last, no-op, missing-neighbour, cross-owner, and concurrent reorder; empty,
boundary, maximum, oversized, first, middle, final, and invalid paging or
binary cases; root and child duplex resources; idle, working, tool, question,
and compaction run states; fresh, resumed, lost, overflowed, and restarted
event cursors. A cosmetic payload variation does not earn another scenario.

Each chaos step must prove the global invariants in master plan 22. The shared
foundation owns only generic deterministic execution and reporting. Catalog,
files, runs, runtime, synchronization, and recovery state models remain in
their respective test files so parallel lanes cannot collide.
