import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never read the machine's real Rig configuration. A developer who keeps a global
// AGENTS.md, happy.toml, or runtime.toml would otherwise change the behaviour of agents under test,
// so a suite that passes on a clean checkout fails on theirs. Point every test at empty directories
// instead.
process.env.RIG_CONFIGURATION_DIRECTORY = mkdtempSync(join(tmpdir(), "rig-test-configuration-"));
process.env.RIG_HOME = mkdtempSync(join(tmpdir(), "rig-test-home-"));
