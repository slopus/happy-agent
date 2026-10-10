import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { writeNativeCapture } from "../../../scripts/write-native-capture.mjs";
import { moduleDatabase } from "../../../../happy-agent-modules/tests/support/moduleDatabase.ts";
import { projectMigrations } from "../../../../happy-agent-modules/sources/projects/ProjectMigrations.ts";
import { insertProjectRow } from "../../../../happy-agent-modules/sources/projects/store/projectRecords.ts";
import { createProjectStore } from "../../../../happy-agent-modules/sources/projects/ProjectStore.ts";
import { ProjectMutations } from "../../../../happy-agent-modules/sources/projects/ProjectMutations.ts";
import { ProjectLifecycleError } from "../../../../happy-agent-modules/sources/projects/ProjectLifecycleError.ts";
import { validateProjectName } from "../../../../happy-agent-modules/sources/projects/impl/projectNames.ts";
import { projectOrderKeyBetween } from "../../../../happy-agent-modules/sources/projects/store/projectRootAgentOrdering.ts";
import { projectEventSchema } from "../../../../happy-agent-modules/sources/projects/ProjectEvent.ts";

const initial = [1, 2, 3].map((index) => ({
    id: `project-${index}`,
    repositoryRef: `/tmp/native-project-edits/${index}`,
    kind: "regular",
    storageKey: `project-${index}`,
    name: `Project ${index}`,
    nameSource: "folder",
    status: index === 3 ? "archived" : "active",
    presence: "present",
    initializationStatus: "ready",
    initializationAttempt: 0,
    worktreeSupport: "unsupported",
    gitAhead: 0,
    gitBehind: 0,
    gitDetached: false,
    orderKey: String(index * 2),
    version: 2,
    createdAt: 100,
    updatedAt: 200,
    ...(index === 3 ? { archivedAt: 200 } : {}),
}));
const database = moduleDatabase(projectMigrations, "native-project-edit-capture");
await database.ready;
const store = createProjectStore();
const mutations = new ProjectMutations(store);
const events = [];
mutations.onEventTransactional((_ctx, event) => {
    assert(Value.Check(projectEventSchema, event));
    events.push(comparableEvent(event));
});
const cases = [];
try {
    for (const project of initial) await insertProjectRow(database.database, project);
    let current = initial[0];
    async function run(kind, input, changeable, payload, operation) {
        const beforeCount = events.length;
        const result = await mutations.run(database.context, {
            projectId: current.id,
            changeable,
            event: (after, before) => ({
                ...payload(after, before),
                project: after,
                previousProject: before,
            }),
            run: (ctx) => operation(ctx, input),
        });
        current = result.project;
        cases.push({
            kind,
            input,
            result: comparableProject(current),
            events: events.slice(beforeCount),
        });
    }
    const rename = async (name) =>
        await run(
            "rename",
            {
                projectId: current.id,
                name: validateProjectName(name),
                expectedVersion: current.version,
            },
            ["name", "nameSource"],
            (_after, before) => ({ type: "project_renamed", previousName: before.name }),
            (ctx, input) => store.rename(ctx, input),
        );
    await rename("  Renamed project  ");
    await rename("Renamed project");
    async function settings(value) {
        const previous = current;
        const beforeCount = events.length;
        const input = { projectId: current.id, settings: value, expectedVersion: current.version };
        const result = await store.updateSettings(database.context, input);
        current = await store.get(database.context, current.id);
        if (result.changed)
            await mutations.observeMutation(
                database.context,
                database.context,
                mutations.newEvent({
                    type: "project_settings_updated",
                    projectId: current.id,
                    project: current,
                    previousProject: previous,
                    settings: value,
                }),
            );
        cases.push({
            kind: "settings",
            input,
            result: comparableProject(current),
            events: events.slice(beforeCount),
        });
    }
    await settings({
        defaultWorkspaceCompute: { type: "docker", image: "fixture:latest" },
        workspaceInitialPrompt: "Prepare this workspace.\nKeep the tests green.",
    });
    await settings({
        workspaceInitialPrompt: "Prepare this workspace.\nKeep the tests green.",
        defaultWorkspaceCompute: { image: "fixture:latest", type: "docker" },
    });
    const reorder = async () =>
        await run(
            "reorder",
            { projectId: current.id, afterId: "project-3", expectedVersion: current.version },
            ["orderKey"],
            (_after, before) => ({ type: "project_reordered", previousOrderKey: before.orderKey }),
            (ctx, input) => store.reorder(ctx, input),
        );
    await reorder();
    await reorder();
    const bytes = Buffer.from("The trusted normalized image processor owns these fixture bytes.");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const asset = {
        bytes,
        contentType: "image/webp",
        contentHash,
        etag: `"${contentHash}"`,
        thumbhash: "Zm9v",
        width: 16,
        height: 16,
    };
    const avatar = { kind: "image", source: "user", thumbhash: asset.thumbhash };
    const setAvatar = async () =>
        await run(
            "set_avatar",
            { projectId: current.id, expectedVersion: current.version, source: "user" },
            ["avatar"],
            () => ({ type: "project_avatar_updated" }),
            (ctx, input) =>
                store.setAvatar(ctx, {
                    projectId: input.projectId,
                    expectedVersion: input.expectedVersion,
                    asset,
                    avatar,
                }),
        );
    await setAvatar();
    await setAvatar();
    const clearAvatar = async () =>
        await run(
            "clear_avatar",
            { projectId: current.id, expectedVersion: current.version },
            ["avatar"],
            () => ({ type: "project_avatar_cleared" }),
            (ctx, input) => store.clearAvatar(ctx, input),
        );
    await clearAvatar();
    await clearAvatar();
    let conflict;
    try {
        await store.rename(database.context, {
            projectId: current.id,
            name: "Stale rename",
            expectedVersion: 2,
        });
    } catch (error) {
        assert(error instanceof ProjectLifecycleError);
        conflict = comparableProject(error.current);
    }
    assert(conflict);
    const orderCases = [
        [null, null],
        ["4", null],
        [null, "4"],
        ["4", "5"],
        ["49", "5"],
        ["4999", "5"],
        ["4999", "5001"],
        ["0", "0001"],
    ].map(([before, after]) => ({ before, after, result: projectOrderKeyBetween(before, after) }));
    const assetCapture = {
        bytes: bytes.toString("base64"),
        metadata: Object.fromEntries(Object.entries(asset).filter(([key]) => key !== "bytes")),
    };
    writeNativeCapture(
        new URL("project_edit_goldens.json", import.meta.url),
        JSON.stringify({ initial, cases, conflict, orderCases, asset: assetCapture }, null, 2) +
            "\n",
    );
} finally {
    database.close();
}

function comparableProject(project) {
    const value = structuredClone(project);
    delete value.updatedAt;
    return value;
}
function comparableEvent(event) {
    const value = structuredClone(event);
    delete value.eventId;
    delete value.at;
    value.project = comparableProject(value.project);
    if (value.previousProject) value.previousProject = comparableProject(value.previousProject);
    return value;
}
