import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfigRootedAt } from "../../../../happy-agent-modules/tests/support/configModule.ts";
import { projectsModuleFor } from "../../../../happy-agent-modules/tests/support/projectsModule.ts";
import { moduleDatabase } from "../../../../happy-agent-modules/tests/support/moduleDatabase.ts";
import { projectMigrations } from "../../../../happy-agent-modules/sources/projects/ProjectMigrations.ts";
import { durableFunctionsMigrations } from "../../../../happy-agent-modules/sources/durableFunctions/index.ts";
import { writeNativeCapture } from "../../../scripts/write-native-capture.mjs";
import { GitModule } from "../../../../happy-agent-modules/sources/git/index.ts";
import { validateManagedProjectFolderName } from "../../../../happy-agent-modules/sources/projects/impl/projectNames.ts";

const root = await mkdtemp(join(tmpdir(), "native-source-project-remote-"));
const database = moduleDatabase(
    [...projectMigrations, ...durableFunctionsMigrations],
    "remote-project-capture",
);
await database.ready;
const config = await testConfigRootedAt(root, undefined, {
    environment: { HOME: root, PATH: "", GITHUB_TOKEN: undefined, GH_TOKEN: undefined },
});
const git = new GitModule();
const projects = projectsModuleFor(config, git);
projects.open("remote-installation-fixture");
const events = [];
const cases = [];
function comparable(value) {
    if (Array.isArray(value)) return value.map(comparable);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(
                    ([key]) =>
                        !["eventId", "at", "createdAt", "updatedAt", "archivedAt"].includes(key),
                )
                .map(([key, value]) => [key, comparable(value)]),
        );
    return typeof value === "string" ? value.replaceAll(root, "%ROOT%") : value;
}
projects.onEventTransactional((_ctx, event) => events.push(comparable(event)));
const input = {
    name: "  remote-folder  ",
    projectId: "projectremotefixtureone",
    source: { kind: "git", url: "https://example.com/owner/repository.git" },
};
async function run(kind, input, operation) {
    const count = events.length;
    try {
        const result = await operation();
        cases.push({ kind, input, result: comparable(result), events: events.slice(count) });
    } catch (error) {
        cases.push({
            kind,
            input,
            error: { code: error.code ?? "invalid_request", message: error.message },
        });
    }
}
try {
    await run("remote", input, () => projects.createRemote(database.context, input));
    await run("remote", input, () => projects.createRemote(database.context, input));
    await run(
        "failed",
        { projectId: input.projectId, error: "A deterministic clone failure." },
        () =>
            projects.markInitializationFailed(database.context, {
                projectId: input.projectId,
                error: "A deterministic clone failure.",
            }),
    );
    await run("remote", input, () => projects.createRemote(database.context, input));
    for (const changed of [
        { ...input, name: "different-folder" },
        { ...input, source: { kind: "git", url: "https://example.com/different.git" } },
        { ...input, projectId: "projectremotefixturetwo" },
        { ...input, secret: { kind: "github" } },
        { ...input, name: "../unsafe" },
        { ...input, projectId: "a".repeat(33) },
    ])
        await run("remote", changed, () => projects.createRemote(database.context, changed));
    await mkdir(join(config.projectsHome, "existing-folder"), { recursive: true });
    const existing = {
        ...input,
        name: "existing-folder",
        projectId: "projectremoteexistingfolder",
    };
    await run("remote", existing, () => projects.createRemote(database.context, existing));
    const github = {
        name: "github-folder",
        projectId: "projectremotegithubfixture",
        source: { kind: "github", repository: "fixture/repository" },
        secret: { kind: "github" },
    };
    await run("remote", github, () => projects.createRemote(database.context, github));
    await run(
        "failed",
        { projectId: github.projectId, error: "GitHub credentials are unavailable." },
        () =>
            projects.markInitializationFailed(database.context, {
                projectId: github.projectId,
                error: "GitHub credentials are unavailable.",
            }),
    );
    await run("remote", github, () => projects.createRemote(database.context, github));
    assert(
        cases[0].result && cases[4].error && cases.at(-1).result.initializationStatus === "failed",
    );
    await run("remote_credential", github, () =>
        projects.createRemote(database.context, github, { githubToken: "fixture-private-token" }),
    );
    await run("remote", github, () => projects.createRemote(database.context, github));
    const nameCases = [];
    for (const name of ["🦉".repeat(70), "🦉".repeat(101)]) {
        try {
            nameCases.push({ name, result: validateManagedProjectFolderName(name) });
        } catch (error) {
            nameCases.push({ name, error: error.message });
        }
    }
    writeNativeCapture(
        new URL("project_remote_goldens.json", import.meta.url),
        JSON.stringify({ cases, nameCases }, null, 2) + "\n",
    );
} finally {
    git.dispose();
    database.close();
    await rm(root, { recursive: true, force: true });
}
