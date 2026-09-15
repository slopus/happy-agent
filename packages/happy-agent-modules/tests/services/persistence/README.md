# Service persistence tests

These tests use the published AgentStorage and AgentKV over real asynchronous SQLite in private
temporary files, including the production connection and process-lock owner. The local libSQL
driver rotates connections after transactions, so a connection-local in-memory database cannot
test this contract correctly.
They cover concurrent capacity admission, outer transaction rollback, confirmed teardown,
admission closure, and bounded history pagination across index pages. No synchronous SQLite shim
or independent mock transaction model is used.
