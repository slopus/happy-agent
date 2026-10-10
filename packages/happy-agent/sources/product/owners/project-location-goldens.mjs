import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfigRootedAt } from "../../../../happy-agent-modules/tests/support/configModule.ts";
import { projectsCatalogFor } from "../../../../happy-agent-modules/tests/support/projectsModule.ts";
import { moduleDatabase } from "../../../../happy-agent-modules/tests/support/moduleDatabase.ts";
import {
    runnersMigrations,
    saveRunnerSnapshot,
} from "../../../../happy-agent-modules/sources/runners/persistence/runnerSnapshot.ts";
import { writeNativeCapture } from "../../../scripts/write-native-capture.mjs";

const root = await mkdtemp(join(tmpdir(), "native-source-home-location-"));
const config = await testConfigRootedAt(
    root,
    '[runners.fixture]\nname = "Fixture runner"\ntoken = "0123456789012345678901234567890123456789012"\n',
);
const project = {
    id: "home-project",
    repositoryRef: "/previous-local-home",
    kind: "home",
    storageKey: "home",
    name: "Home",
    nameSource: "folder",
    status: "active",
    presence: "present",
    initializationStatus: "ready",
    initializationAttempt: 0,
    worktreeSupport: "unknown",
    gitAhead: 0,
    gitBehind: 0,
    gitDetached: false,
    orderKey: "500",
    version: 1,
    createdAt: 100,
    updatedAt: 100,
};
const cases = [];
try {
    for (const home of ["/cached-runner-home", null]) {
        const database = moduleDatabase(runnersMigrations, "native-source-home-location");
        await database.ready;
        const snapshot = {
            runners: [
                {
                    id: "fixture",
                    name: "Fixture runner",
                    default: true,
                    status: "disconnected",
                    machine:
                        home === null
                            ? null
                            : {
                                  version: "fixture",
                                  platform: "linux",
                                  arch: "x64",
                                  hostname: "fixture",
                                  home,
                              },
                    protocol: null,
                    since: 100,
                    reason: null,
                },
            ],
            version: "fixture-version",
        };
        await saveRunnerSnapshot(database.context, snapshot);
        const { projects, runners } = projectsCatalogFor(config);
        runners.beforeStart(database.context);
        await runners.afterStart(database.context);
        const compute = projects.compute(project);
        let location;
        let unavailable = false;
        try {
            location = projects.location(project);
        } catch (error) {
            unavailable = error.name === "RunnerUnavailableError";
        }
        assert.deepEqual(compute, { type: "runner", runnerId: "fixture", path: home });
        assert.equal(unavailable, home === null);
        cases.push({ snapshot, compute, ...(location ? { location } : {}), unavailable });
        await runners.close();
        database.close();
    }
    writeNativeCapture(
        new URL("project_location_goldens.json", import.meta.url),
        JSON.stringify({ project, cases }, null, 2) + "\n",
    );
} finally {
    await rm(root, { recursive: true, force: true });
}
