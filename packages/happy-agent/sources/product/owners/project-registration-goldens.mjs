import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfigRootedAt } from "../../../../happy-agent-modules/tests/support/configModule.ts";
import { projectsModuleFor } from "../../../../happy-agent-modules/tests/support/projectsModule.ts";
import { moduleDatabase } from "../../../../happy-agent-modules/tests/support/moduleDatabase.ts";
import { projectMigrations } from "../../../../happy-agent-modules/sources/projects/ProjectMigrations.ts";
import { durableFunctionsMigrations } from "../../../../happy-agent-modules/sources/durableFunctions/index.ts";
import { writeNativeCapture } from "../../../scripts/write-native-capture.mjs";

const root = await mkdtemp(join(tmpdir(), "native-source-project-registration-"));
const database = moduleDatabase(
    [...projectMigrations, ...durableFunctionsMigrations],
    "native-source-project-registration",
);
await database.ready;
const config = await testConfigRootedAt(root, undefined, {
    environment: { HOME: root, PATH: "", GITHUB_TOKEN: undefined, GH_TOKEN: undefined },
});
const projects = projectsModuleFor(config);
const events = [];
projects.onEventTransactional((_ctx, event) => events.push(comparable(event)));
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
try {
    await mkdir(join(root, "plain-folder"));
    await mkdir(join(root, "other-folder"));
    await mkdir(join(root, "  "));
    await symlink(join(root, "plain-folder"), join(root, "alias"));
    await writeFile(join(root, "file"), "a regular file");
    async function run(kind, input, operation) {
        const count = events.length;
        const result = await operation();
        cases.push({
            kind,
            input: comparable(input),
            result: comparable(result),
            events: events.slice(count),
        });
    }
    const id = "projectregisterfixtureone";
    await run("register", { path: join(root, "plain-folder"), projectId: id }, () =>
        projects.register(database.context, { path: join(root, "plain-folder"), projectId: id }),
    );
    await run(
        "register",
        { path: join(root, "alias"), projectId: "projectregisterfixturealias" },
        () =>
            projects.register(database.context, {
                path: join(root, "alias"),
                projectId: "projectregisterfixturealias",
            }),
    );
    await run("set_up_again", { projectId: id }, () => projects.setUpAgain(database.context, id));
    await run("archive", { projectId: id }, () => projects.archive(database.context, id));
    await run("register", { path: join(root, "alias") }, () =>
        projects.register(database.context, { path: join(root, "alias") }),
    );
    for (const [path, projectId] of [
        ["missing", undefined],
        ["file", undefined],
        ["other-folder", id],
        ["other-folder", "a".repeat(33)],
    ]) {
        let code;
        try {
            await projects.register(database.context, {
                path: join(root, path),
                ...(projectId ? { projectId } : {}),
            });
        } catch (error) {
            code = error.code;
        }
        assert(code);
        cases.push({
            kind: "registration_error",
            input: { path: `%ROOT%/${path}`, ...(projectId ? { projectId } : {}) },
            code,
        });
    }
    await run("register", { path: join(root, "  "), projectId: "projectregisterwhitespace" }, () =>
        projects.register(database.context, {
            path: join(root, "  "),
            projectId: "projectregisterwhitespace",
        }),
    );
    writeNativeCapture(
        new URL("project_registration_goldens.json", import.meta.url),
        JSON.stringify({ cases }, null, 2) + "\n",
    );
} finally {
    database.close();
    await rm(root, { recursive: true, force: true });
}
