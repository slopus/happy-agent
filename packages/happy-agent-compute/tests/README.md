# Compute test coverage

The ordinary suite is deterministic and uses fakes where a unit boundary is intentional. The
`tests/live` lane is the evidence for claims that only an operating-system sandbox, Docker daemon,
or real backend can prove.

## Running live tests

Live tests are opt-in:

```sh
HAPPY_AGENT_COMPUTE_LIVE_TEST=1 pnpm --filter @slopus/happy-agent-compute \
  exec vitest run tests/live
```

The Docker image defaults to `happy-terminal-gym:local`. Override it with
`HAPPY_AGENT_COMPUTE_DOCKER_IMAGE`. The image must contain a POSIX shell and the commands used by
the live cases. Managed containers receive the static Linux supervisor from the package; attached
containers must already mount the matching installed NPM artifact read-only at
`/tools/happy-agent-sandbox` and use Docker's `seccomp=unconfined`, `apparmor=unconfined`, and
`systempaths=unconfined` security options so the supervisor can install its own boundary.

Run the host lane outside an already restricted process. macOS Seatbelt and the Linux supervisor
cannot necessarily nest inside an agent or CI runner sandbox. Run the Docker lane where the Docker
socket is available.

When the opt-in is absent, live cases are reported as skipped. When it is present, a missing OS
sandbox, Docker daemon, or Docker image throws from setup and fails the suite. A live prerequisite
must never turn into a passing assertion.

## Happy Agent parity audit

Status meanings:

- **Present**: compute exercises the same observable contract at an equal or stronger boundary.
- **Weaker**: compute has coverage, but replaces a real boundary with a fake or omits material Happy Agent
  cases.
- **Missing**: no compute test establishes the Happy Agent contract.
- **Vacuous**: a nominal compute test can finish without executing its assertions.
- **Out of scope**: the test belongs to Happy Agent's agent loop, reviewer, UI, provider, or session layer;
  it is listed so absence is explicit rather than accidental.
- **Obsolete**: the Happy Agent test targets the deleted ambient permission-revision model. The compute
  equivalent is the new immutable per-operation contract.

### Agent context, filesystem, sandbox, and network

| Happy Agent test                                            | Compute equivalent                                                                 | Status                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loadProjectManagedNetworkPolicy.test.ts`                   | `tests/network/toManagedNetworkPolicy.test.ts`, Docker loader test                 | Present for the compute-owned policy translation and Docker file framing                                                                                                                                     |
| `assertCanWritePath.test.ts`                                | `tests/sandbox/assertCanWritePath.test.ts`, host/just-bash/Docker permission tests | Present; compute adds caller denials and grants                                                                                                                                                              |
| `createJustBashBashContext.test.ts`                         | `tests/justBash/createJustBashCompute.test.ts`                                     | Weaker; exit reporting is present, but oldest-session eviction and completed-session retention have no equivalent assertion                                                                                  |
| `createJustBashFileSystemContext.test.ts`                   | `tests/justBash/createJustBashCompute.test.ts`                                     | Present                                                                                                                                                                                                      |
| `createSupervisorPolicy.test.ts`                            | `tests/supervisor/createSupervisorPolicy.test.ts`                                  | Present; the published supervisor owns native filesystem and network enforcement                                                                                                                             |
| `createNodeAgentContext.test.ts` filesystem and shell cases | host compute, filesystem, shell, and host live tests                               | Weaker; core execution is present, while Git broker, Git identity, selected-secret injection, and provider-control-channel cases remain above this package                                                   |
| `createNodeBashContext.test.ts`                             | `tests/host/createHostShell.test.ts`                                               | Weaker; timeout, deltas, stdin, process-tree stop, exit notification, eviction, and network mapping are present; cleanup-failure, orphan-child, peek, retention-cap, and several lifecycle races are missing |
| `createNodeFileSystemContext.test.ts`                       | `tests/host/createHostCompute.test.ts`, host live tests                            | Present for paging, bounded reads, `noFollow`, per-operation permissions, and host read/write boundaries                                                                                                     |
| `createProtectedPathMonitor.test.ts`                        | none                                                                               | Missing                                                                                                                                                                                                      |
| `createSensitiveReadPaths.test.ts`                          | same-named sandbox test                                                            | Present                                                                                                                                                                                                      |
| `createShellEnvironment.test.ts`                            | same-named sandbox test                                                            | Present                                                                                                                                                                                                      |
| `createToolEnvironment.test.ts`                             | same-named sandbox test                                                            | Present                                                                                                                                                                                                      |
| `isPathInsideWorkspace.test.ts`                             | same-named sandbox test                                                            | Present                                                                                                                                                                                                      |
| `justBashArchiveCodecs.test.ts`                             | none                                                                               | Missing                                                                                                                                                                                                      |
| `resolveFileSystemPath.test.ts`                             | same-named sandbox test                                                            | Present                                                                                                                                                                                                      |
| `runCleanupSteps.test.ts`                                   | same-named sandbox test                                                            | Present                                                                                                                                                                                                      |
| `subagentSelectionDescriptions.test.ts`                     | none                                                                               | Out of scope                                                                                                                                                                                                 |

### Docker execution

| Happy Agent test                                | Compute equivalent                                                   | Status                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DockerEnvironment.test.ts`                     | `tests/docker/DockerEnvironment.test.ts`, Docker disposal live cases | Present; compute adds missing-container errors and real managed/attached disposal                                                           |
| `assertDockerReadPath.test.ts`                  | same-named Docker test                                               | Present; compute adds denied reads                                                                                                          |
| `assertDockerWritePath.test.ts`                 | same-named Docker test                                               | Present; compute adds read-only, grants, denials, and denial precedence                                                                     |
| `createDockerBashContext.test.ts`               | `tests/docker/createDockerShell.test.ts`, Docker timeout live case   | Weaker; most session mechanics are ported, but Git broker, selected secrets, and permission-revision races are not applicable or not ported |
| `createDockerFileSystemContext.test.ts`         | `tests/docker/createDockerFileSystem.test.ts`                        | Present at the fake-daemon boundary                                                                                                         |
| `createDockerFileSystemContext.docker.test.ts`  | `tests/live/dockerBackend.live.test.ts`                              | Present and broader: a real daemon is used for containment, atomic `noFollow`, sessions, network, and disposal                              |
| `createDockerSupervisorCommand.test.ts`         | `tests/docker/impl/createDockerSupervisorCommand.test.ts`            | Present; direct argv policy transport preserves workload stdin and avoids a mutable in-container policy file                                |
| `formatDockerTouchTimestamp.test.ts`            | same-named Docker test                                               | Present                                                                                                                                     |
| `loadDockerProjectManagedNetworkPolicy.test.ts` | same-named Docker test                                               | Present                                                                                                                                     |
| `parseDockerPathStat.test.ts`                   | same-named Docker test                                               | Present                                                                                                                                     |
| `resolveDockerExecutionConfig.test.ts`          | same-named Docker test                                               | Present                                                                                                                                     |
| `resolveDockerPath.test.ts`                     | same-named Docker test                                               | Present                                                                                                                                     |
| `runDockerExec.test.ts`                         | same-named Docker test                                               | Present                                                                                                                                     |
| `validateDockerExecutionConfig.test.ts`         | same-named Docker test                                               | Present; compute adds union and absolute-path validation                                                                                    |

All pre-existing compute Docker tests use hand-written Dockerode fakes. They prove request
construction, parsing, lifecycle coordination, and fail-closed decisions, but they do not prove
Linux mount, user, PID, or network namespaces. Only `tests/live/dockerBackend.live.test.ts` makes
those kernel claims.

### Existing compute-only coverage defects

| Compute test                             | Live replacement                        | Status                                                                                                                          |
| ---------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tests/host/hostSandboxBoundary.test.ts` | `tests/live/hostSandbox.live.test.ts`   | Vacuous when its nested-sandbox probe fails: both cases return before asserting. It must not be cited as host boundary evidence |
| Existing `tests/docker/*.test.ts`        | `tests/live/dockerBackend.live.test.ts` | Weaker before this work: every Dockerode interaction was fake and no daemon or kernel boundary ran                              |

### Processes

| Happy Agent test               | Compute equivalent                            | Status                                                                                                         |
| ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `BoundedOutputBuffer.test.ts`  | `tests/processes/BoundedOutputBuffer.test.ts` | Weaker; compute covers head/tail, offsets, and drain, but not Happy Agent's exact partial-UTF-8 boundary cases |
| `NativeProcessManager.test.ts` | same-named process test                       | Present                                                                                                        |
| `waitForProcessExit.test.ts`   | same-named process test                       | Present                                                                                                        |

### Permission subsystem

The package owns the execution boundary after a permission decision. It does not own Happy Agent's
automatic reviewer, transcript construction, tool policy, terminal disclosure, or permission menu.

| Happy Agent test                                                           | Compute equivalent                                      | Status                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `createPermissionContext.test.ts`, `assertPermissionRevision.ts` consumers | operation-scoped permission tests on all three backends | Obsolete; mutable revisions were deleted and replaced by immutable values passed to each operation |
| `isProtectedPath.test.ts`                                                  | sandbox and backend grant/deny tests                    | Present behaviorally; no direct same-function unit test                                            |
| `isPermissionReduction.test.ts`                                            | none                                                    | Out of scope; stopping privileged processes after a UI/session downgrade is owned above compute    |
| `parsePermissionMode.test.ts`                                              | TypeBox `computePermissionModeSchema` consumers         | Weaker; runtime schema exists but has no direct schema test                                        |
| `AutoPermissionDenialCircuitBreaker.test.ts`                               | none                                                    | Out of scope                                                                                       |
| `autoPermission.live.test.ts`                                              | none                                                    | Out of scope                                                                                       |
| `createAutoPermissionTranscript.test.ts`                                   | none                                                    | Out of scope                                                                                       |
| `createPermissionReviewSideAgent.test.ts`                                  | none                                                    | Out of scope                                                                                       |
| `parseAutoPermissionReview.test.ts`                                        | none                                                    | Out of scope                                                                                       |
| `quoteVisibleExact.test.ts`                                                | none                                                    | Out of scope                                                                                       |
| `reviewAutoPermission.test.ts`                                             | none                                                    | Out of scope                                                                                       |
| `shouldAllowAutoPermissionReview.test.ts`                                  | none                                                    | Out of scope                                                                                       |
| `shouldReviewPatchInAutoMode.test.ts`                                      | none                                                    | Out of scope                                                                                       |
| `summarizeEscalatedShellAction.test.ts`                                    | none                                                    | Out of scope                                                                                       |
| `toolAutoPermissionPolicies.test.ts`                                       | none                                                    | Out of scope                                                                                       |

### Relevant gym coverage

Gym proves the assembled Happy Agent product through a real PTY. Compute tests cannot replace its agent,
session, and terminal assertions, but the backend contracts should have a lower-level equivalent.

| Gym test                                                            | Compute equivalent                                          | Status                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `background_child_survives_the_command_that_started_it.test.ts`     | host shell process ownership tests                          | Weaker; no compute live orphan-child case                                                                           |
| `background_shell_output_continues_after_retention_cap.test.ts`     | host/Docker delta and cap tests                             | Present at backend boundary                                                                                         |
| `aborting_active_session_stops_background_processes.test.ts`        | compute disposal and kill tests                             | Weaker; abort/session ownership is above compute                                                                    |
| `aborting_idle_session_stops_background_processes.test.ts`          | compute disposal tests                                      | Weaker; archive/session ownership is above compute                                                                  |
| `reducing_permissions_stops_existing_full_access_processes.test.ts` | none                                                        | Out of scope under per-operation compute permissions; the owning session must decide which existing process to stop |
| `docker_session_routes_files_and_commands_to_container.test.ts`     | Docker filesystem/shell tests and live lane                 | Present at backend boundary                                                                                         |
| `docker_shell_respects_permission_mode.test.ts`                     | Docker containment live case                                | Present                                                                                                             |
| `docker_managed_network_reaches_allowed_http_service.test.ts`       | Docker managed-network live case                            | Present in the native-Linux live lane                                                                               |
| `managed_network_request_runs_through_linux_proxy_bridge.test.ts`   | supervisor proxy unit tests and Docker live case            | Present at the native supervisor and package-wiring boundaries                                                      |
| `sandbox_policy_files_cannot_be_poisoned_by_model_commands.test.ts` | protected-path and sandbox-command tests                    | Weaker; no compute live concurrent policy-poisoning case                                                            |
| `workspace_write_uses_codex_linux_sandbox.test.ts`                  | Linux command construction and host/Docker live containment | Present at backend boundary                                                                                         |
| `workspace_write_custom_shell_cannot_bypass_sandbox.test.ts`        | host/Docker custom-shell validation and live containment    | Weaker; no hostile custom-shell live case                                                                           |
| `workspace_write_cannot_install_hidden_git_hooks.test.ts`           | Git protected-path unit tests                               | Weaker; no compute live Git-hook attempt                                                                            |
| `restricted_shell_wrapper_does_not_run_host_profiles.test.ts`       | shell environment unit tests                                | Missing as a live compute scenario                                                                                  |
| `permissions_menu_enforces_read_only_then_full_access.test.ts`      | per-operation read-only/full-access tests                   | Present at backend boundary; menu behavior is out of scope                                                          |
| Auto-review and permission-disclosure gym files                     | none                                                        | Out of scope; they test reviewer authorization, tool policy, and TUI disclosure                                     |

## Live cases and what they prove

### Host

- A real restricted process cannot write outside the workspace, and can write inside it.
- A real read-only process cannot write the workspace.
- `deniedWritePaths` is enforced inside the workspace.
- `allowedWritePaths` opens one real root outside the workspace.
- A write denial beats both the workspace grant and an explicit grant.
- macOS Seatbelt blocks first-time creation of a protected project path without a host watcher.
- Fifty consecutive macOS restricted commands complete without a policy descriptor.
- `deniedReadPaths` masks real content, including when the path is also granted.
- Withheld egress blocks real `curl`.
- Withheld local binding blocks a real Node listener in a restricted mode.
- Granted unbounded egress reaches a real HTTPS destination.

The fixture deliberately lives beside the test so its outside-workspace target is explicit and
independent from operating-system temporary-directory conventions.

### Docker

- A managed container is really started.
- The container user is first shown able to write `/home/rig` in Full access; a restricted command
  is then shown unable to write it while still writing `/workspace`.
- A live final-component swap races regular files against a symlink while `noFollow` reads through
  Docker's archive API. Any returned bytes must be the regular file, never the target.
- Allowed and denied host policies traverse the supervisor's real command-scoped proxy.
- A timed-out session stays running, observes a release file, and completes afterwards.
- Disposal removes a managed container.
- Disposal leaves an explicitly attached container running.

### Just-bash

- Direct filesystem calls and actual just-bash shell execution share the granular permission
  boundary.
- Read and write denials beat grants.
- An outside write grant applies to only the operation that carries it; the next operation does not
  retain it.

The supervisor's native suite owns exhaustive proxy behavior in
`packages/happy-agent-supervisor/native/supervisor/tests/outgoing_proxy.rs`. Compute's native-Linux
Docker live case proves the package wiring: policy translation, mounted binary, stdin transport,
allowed egress, and denied egress.

## Live-test scope

- The detailed concurrent project-policy, protected Git-hook, hostile custom-shell, and
  restricted-profile contracts proven by Happy Agent/gym do not all have package-level live equivalents.
- Old ambient permission-revision races are intentionally obsolete. Compute instead tests immutable
  operation snapshots; higher layers own stopping processes after a later permission reduction.
- The Docker egress case runs only on a native Linux daemon. Docker Desktop is still covered for
  container lifecycle and filesystem behavior, but it does not provide the same nested namespace
  environment.
