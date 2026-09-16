# Workspace service tests

`ServiceInput` exercises independent readers, concurrent consumption, current write permissions,
pre-write validation, remaining output after exit, and caller-only cancellation. `ServiceTools`
executes the actual common definitions, checks review/no-elevation/replay metadata and exact
schemas, verifies peer management and wait defaults, and bounds discovery with older active rows.

`impl/` exercises service-owned protocol helpers independently of process execution. These tests
do not replace native sandbox, real service lifecycle, or browser transport checks.
