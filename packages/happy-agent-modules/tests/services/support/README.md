# Service controller fixtures

The harness uses the published SQLite connection, real AgentStorage/AgentKV, real project and
workspace catalogs, and the actual Durable Functions dispatcher. Only the compute execution and
agent collection are scripted. These tests establish ownership, transaction, recovery, and access
contracts; the separate native live lane establishes kernel isolation and actual teardown proof.

Fixture cleanup closes admission, confirms service termination, waits for durable-call retirement,
then closes and removes its private database directory.
