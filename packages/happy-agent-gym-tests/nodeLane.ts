// The Node lane. The gym runs on Bun, as Happy Agent does in production, but source-mode daemons
// and some tools still run the same code under Node, whose streams behave differently: Node may
// flush a blocked write without emitting 'drain'. These tests must also pass under Node. Terminals
// open only under Bun, so no scenario here opens one.

/** Gym scenarios that run under Node as well as Bun. */
export const nodeLaneScenarios: readonly string[] = [
    // Transport and streaming: SSE frames, file bodies, proxied bodies, and request paths.
    "happy_api_events_transport_matrix.test.ts",
    "happy_api_proxy_matrix.test.ts",
    "happy_api_files_git.test.ts",
    "workspace_files_transfer_fifty_mebibytes.test.ts",
    "happy_api_artifacts_serve_file_bundles.test.ts",
    // The event stream, bootstrap, and replica reconciliation.
    "happy_api_sync_concurrency.test.ts",
    "sync_replica_preserves_newer_nested_agents.test.ts",
    // Run lifecycle.
    "run_lifecycle_uses_durable_history.test.ts",
    "happy_api_transcript_runs.test.ts",
    "monty_workers_end_with_their_daemon.test.ts",
    "new_task_and_bot_names_survive_transient_failures.test.ts",
    // A representative core sample.
    "happy_api_platform.test.ts",
    "happy_api_workspaces.test.ts",
    "happy_api_agent_catalog.test.ts",
];

/** Gym scenarios that prove Node-only behavior, so they run in the Node lane alone. */
export const nodeOnlyScenarios: readonly string[] = [
    "terminals_are_unsupported_without_bun.test.ts",
];

/** Unit test paths, relative to `packages/happy-agent-modules`, that also run under Node. */
export const nodeLaneModuleTests: readonly string[] = [
    "tests/transport/sseWriter.test.ts",
    "tests/transport/streamToOutgoing.test.ts",
    "tests/transport/WebSocketDuplex.test.ts",
];
