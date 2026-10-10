import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../happy-terminal/package.json", import.meta.url));
const { HappyAgentClient, agentSchema, agentProfileCatalogSchema, slashCommandCatalogSchema } =
    await import(require.resolve("@slopus/happy-agent-client"));
const { Value } = require("@sinclair/typebox/value");
const [endpoint, parentId, mainId, nestedId, siblingId, hiddenId, workspaceId] =
    process.argv.slice(2);
const client = new HappyAgentClient({ endpoint, token: process.env.HAPPY_TEST_API_TOKEN });
const checked = (schema, value) => {
    assert(
        Value.Check(schema, value),
        JSON.stringify([...Value.Errors(schema, value)].slice(0, 5)),
    );
    return value;
};
const focused = async (id) => {
    const response = await client.getAgent(id);
    checked(agentSchema, response.agent);
    checked(agentProfileCatalogSchema, response.profiles);
    checked(slashCommandCatalogSchema, response.slashCommands);
    await client.getEvents({ after: response.agent.lastCursor });
    return response.agent;
};
const root = await focused(parentId);
assert.equal(root.workspaceId, workspaceId);
assert.deepEqual(new Set(root.subtasks.map((task) => task.id)), new Set([mainId, siblingId]));
const main = root.subtasks.find((task) => task.id === mainId);
assert.equal(main.workspaceId, workspaceId);
assert.equal(main.canSendMessages, true);
assert.equal(main.managedByAnotherAgent, true);
assert.equal(main.subtask, true);
assert.deepEqual(main.subagents, { total: 2, running: 1 });
assert.deepEqual(
    main.subtasks.map((task) => task.id),
    [nestedId],
);
assert.deepEqual(main.subtasks[0].subtasks, []);
assert.equal(main.version, (await focused(mainId)).version);
assert.equal(main.subtasks[0].version, (await focused(nestedId)).version);
const hidden = await focused(hiddenId);
assert.equal(hidden.workspaceId, workspaceId);
assert.equal(hidden.status, "working");
assert.equal(hidden.userVisible, false);
assert.equal(hidden.canSendMessages, false);
console.log("Published client validated independently versioned subtask trees");
