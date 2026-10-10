import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Readable } from "node:stream";
const require = createRequire(new URL("../../happy-terminal/package.json", import.meta.url));
const {
    HappyAgentClient,
    HappyAgentApiError,
    configResponseSchema,
    desktopBootstrapResponseSchema,
    onboardingCompletedResponseSchema,
    onboardingStateSchema,
    projectListResponseSchema,
    projectResponseSchema,
    workspaceListResponseSchema,
    workspaceResponseSchema,
} = await import(require.resolve("@slopus/happy-agent-client"));
const { Value } = require("@sinclair/typebox/value");
const [home, workspaceId, activeAgentId, archivedAgentId, childId, grandchildId, archivedChildId] =
    process.argv.slice(2);
const directory = join(home, "agent");
const socketFetch = (input, init = {}) =>
    new Promise((resolve, reject) => {
        const url = new URL(input);
        const req = request(
            {
                socketPath: join(directory, "server.sock"),
                path: url.pathname + url.search,
                method: init.method ?? "GET",
                headers: Object.fromEntries(new Headers(init.headers)),
                signal: init.signal,
            },
            (res) =>
                resolve(
                    new Response(Readable.toWeb(res), {
                        status: res.statusCode,
                        headers: res.headers,
                    }),
                ),
        );
        req.on("error", reject);
        req.end(init.body);
    });
const client = new HappyAgentClient({
    endpoint: "http://happy",
    token: readFileSync(join(directory, "token"), "utf8").trim(),
    fetch: socketFetch,
});
const checked = (schema, value) => {
    assert(
        Value.Check(schema, value),
        JSON.stringify([...Value.Errors(schema, value)].slice(0, 5)),
    );
    return value;
};
const rejected = async (promise, status) => {
    await assert.rejects(
        promise,
        (error) => error instanceof HappyAgentApiError && error.status === status,
    );
};

// The catalog: one project, whose active root agent is embedded and whose archived one is not.
const listed = checked(projectListResponseSchema, await client.listProjects());
assert.equal(listed.projects.length, 1);
const [project] = listed.projects;
assert.equal(project.id, workspaceId);
assert.equal(project.status, "active");
assert.equal(project.nameSource, "user");
assert.deepEqual(project.compute.type, "host");
assert.deepEqual(project.settings, {
    defaultWorkspaceCompute: { type: "host" },
    workspaceInitialPrompt: null,
});
assert.deepEqual(
    project.agents.map((agent) => agent.id),
    [activeAgentId],
);
assert.equal(project.agents[0].workspaceId, workspaceId);
const focused = checked(projectResponseSchema, await client.getProject(workspaceId));
assert.deepEqual(focused.project, project);
await rejected(client.getProject("projectmissing"), 404);
const configuration = checked(configResponseSchema, await client.getConfig()).config;
assert.equal(configuration.presence.current, "online");
assert.equal(configuration.presence.fallback, "online");
assert.equal(configuration.presence.states.online.title, "Online");
assert.equal(configuration.presence.states.online.answerWaitMs, null);
assert.equal(configuration.presence.states.away.answerWaitMs, 0);

// The project is its own root workspace, with the same agent series and version clock; the
// tree is flat, ordered, and leaves archived workspaces out unless asked.
const workspaces = checked(workspaceListResponseSchema, await client.listWorkspaces());
assert.deepEqual(
    workspaces.workspaces.map((workspace) => [workspace.id, workspace.parentId]),
    [
        [workspaceId, null],
        [childId, workspaceId],
        [grandchildId, childId],
    ],
);
const [root, child, grandchild] = workspaces.workspaces;
assert.equal(root.projectId, workspaceId);
assert.equal(root.kind, "root");
assert.equal(root.version, project.version);
assert.deepEqual(root.agents, project.agents);
assert.deepEqual(
    checked(workspaceResponseSchema, await client.getWorkspace(workspaceId)).workspace,
    root,
);
assert.equal(child.projectId, workspaceId);
assert.equal(child.kind, "worktree");
assert.equal(child.status, "active");
assert.equal(child.nameSource, "user");
assert.deepEqual(child.initialization, { status: "ready", attempt: 1, error: null });
assert.deepEqual(child.base, { ref: "main", commit: "4f2a1c9" });
assert.deepEqual(child.git, {
    branch: "fix-login",
    head: "8b3d2e1",
    upstream: null,
    ahead: 3,
    behind: 0,
    detached: false,
});
assert.equal(child.compute.type, "host");
assert.deepEqual(child.agents, []);
assert.equal(grandchild.projectId, workspaceId);
assert.equal(grandchild.kind, "copy");
assert.equal(grandchild.base, null);
assert.deepEqual(
    checked(workspaceResponseSchema, await client.getWorkspace(grandchildId)).workspace,
    grandchild,
);
const history = checked(
    workspaceListResponseSchema,
    await client.listWorkspaces({ projectId: workspaceId, includeArchived: true }),
);
assert.deepEqual(
    history.workspaces.map((workspace) => [workspace.id, workspace.status]),
    [
        [workspaceId, "active"],
        [childId, "active"],
        [grandchildId, "active"],
        [archivedChildId, "archived"],
    ],
);
assert.equal(history.workspaces[3].archivedAt, 1700000009000);
assert.deepEqual((await client.listWorkspaces({ projectId: "projectother" })).workspaces, []);
await rejected(client.getWorkspace("workspacemissing"), 404);

// One snapshot composes exactly what the focused endpoints answer.
const onboarding = checked(onboardingStateSchema, await client.getOnboarding());
assert.equal(onboarding.steps.project.done, true);
const before = checked(desktopBootstrapResponseSchema, await client.getDesktopBootstrap());
assert.deepEqual(before.config, (await client.getConfig()).config);
assert.deepEqual(before.profile, (await client.getProfile()).profile);
assert.deepEqual(before.cloud, (await client.getCloud()).cloud);
assert.deepEqual(before.onboarding, onboarding);
assert.deepEqual(before.projects, [project]);
// Deliberately shallow: the root workspace and the workspaces directly under it.
assert.deepEqual(before.workspaces, [root, child]);
assert.deepEqual(
    before.archivedAgents.map((agent) => [agent.id, agent.workspaceId, agent.archivedAt !== null]),
    [[archivedAgentId, workspaceId, true]],
);
assert.equal(typeof before.cursor, "string");
await client.getEvents({ after: before.cursor });

// Completing onboarding is reflected by the next snapshot.
assert.deepEqual(checked(onboardingCompletedResponseSchema, await client.completeOnboarding()), {
    completed: true,
});
const after = checked(desktopBootstrapResponseSchema, await client.getDesktopBootstrap());
assert.equal(after.onboarding.completed, true);
assert.deepEqual(after.onboarding, await client.getOnboarding());
console.log("Published client read the catalog and desktop bootstrap");
