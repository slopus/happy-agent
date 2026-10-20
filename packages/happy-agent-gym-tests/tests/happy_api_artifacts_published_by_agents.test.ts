import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const CHART = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);
const ENTRY = "# Q3 revenue\n\n![Revenue](images/chart.png)\n";

/** A gym whose model makes exactly the tool call a scenario asks for in a given conversation. */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        files: { "reports/chart.png": CHART },
        inference: (request) => {
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Artifact work settled." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function call(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `artifact_test_${String(++callIndex)}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please execute ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "auto",
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
    }
    return { gym, call };
}

describe("artifacts published by agents", () => {
    it("records the agent and its project, and announces the change without a mutation", async () => {
        const { gym, call } = await harness();
        const agentId = gym.defaultSessionId;
        const projectId = (await gym.getSession()).workspaceId;
        const before = (await gym.client.getEvents()).latestCursor;

        const created = await call(agentId, "create_artifact", {
            type: "markdown",
            title: "Q3 revenue report",
            display: "inline_expanded",
            files: [{ path: "images/chart.png", fromPath: "reports/chart.png" }],
        });
        expect(created.text).toContain('Artifact created: "Q3 revenue report"');

        const { artifacts } = await gym.client.listArtifacts();
        expect(artifacts).toHaveLength(1);
        const artifact = artifacts[0]!;
        expect(created.text).toContain("write_artifact_file and edit_artifact_file");
        expect(artifact).toMatchObject({
            type: "markdown",
            entry: { path: "index.md", mimeType: "text/markdown" },
            fileCount: 2,
            display: "inline_expanded",
            source: { kind: "project", projectId, agentId },
            createdBy: { kind: "agent", agentId, botId: null },
            updatedBy: { kind: "agent", agentId, botId: null },
            updatedSource: { kind: "project", projectId, agentId },
        });
        const chart = await gym.client.getArtifactFile(artifact.id, 1, "images/chart.png");
        expect(new Uint8Array(chart!.data)).toEqual(CHART);
        // The catalog holds the only copy; nothing of the artifact is written in the project.
        await expect(gym.readFile(".happy-artifacts/.gitignore")).rejects.toThrow();

        // The agent patches the entry with the artifact edit tool, which makes the next version.
        const edited = await call(agentId, "edit_artifact_file", {
            artifactId: artifact.id,
            path: "index.md",
            old_string: "# Q3 revenue report\n",
            new_string: "# Q3 revenue\n\n![Revenue](images/chart.png)\n",
        });
        expect(edited.text).toContain(`artifact ${artifact.id} is now at version 2 (1.1)`);
        const { artifact: written } = await gym.client.getArtifact(artifact.id);
        expect(written.latestVersion).toBe(2);
        const entry = await gym.client.getArtifactFile(artifact.id, "latest", "index.md");
        expect(Buffer.from(entry!.data).toString("utf8")).toBe(ENTRY);

        // A person's change and the agent's own both make versions under their own names.
        const { artifact: retitled } = await gym.client.updateArtifact(
            artifact.id,
            { mutationId: "retitle", title: "Q3 revenue report, reviewed" },
            { ifMatch: written.version },
        );
        expect(retitled).toMatchObject({
            updatedBy: { kind: "user", userId: null },
            display: "inline_expanded",
        });
        await call(agentId, "write_artifact_file", {
            artifactId: artifact.id,
            path: "notes.md",
            content: "Checked against the ledger.\n",
        });
        // The shell never reaches an artifact: there is no copy on the machine to change.
        const { artifact: latest } = await gym.client.getArtifact(artifact.id);
        expect(latest).toMatchObject({
            latestVersion: 4,
            title: "Q3 revenue report, reviewed",
            fileCount: 3,
            display: "inline_expanded",
            createdBy: { kind: "agent", agentId, botId: null },
            updatedBy: { kind: "agent", agentId, botId: null },
        });
        expect(created.text).toContain(
            `Reference it in chat as <happy-artifact id="${artifact.id}"/>.`,
        );
        const updated = await call(agentId, "update_artifact", {
            artifactId: artifact.id,
            display: "side",
            major: 2,
        });
        expect(updated.text).toContain(`Artifact ${artifact.id} is now at version 5 (2.0)`);
        expect(updated.text).toContain(`<happy-artifact id="${artifact.id}" version="5"/>`);

        // The agent reads what it published back.
        const read = await call(agentId, "read_artifact", { artifactId: artifact.id });
        expect(read.text).toContain("Q3 revenue report, reviewed");
        expect(read.text).toContain("images/chart.png");

        const events = (await gym.client.getEvents({ after: before, limit: 1000 })).events.filter(
            (event) => event.type.startsWith("artifact."),
        );
        expect(events.map((event) => event.type)).toEqual([
            "artifact.created",
            "artifact.updated",
            "artifact.updated",
            "artifact.updated",
            "artifact.updated",
        ]);
        expect(events[0]!.payload).toEqual({ artifact });
        expect(events[1]!.payload).not.toHaveProperty("mutationId");
        expect(events[2]!.payload).toMatchObject({ mutationId: "retitle" });
        expect(events[3]!.payload).toMatchObject({
            artifactId: artifact.id,
            previousVersion: retitled.version,
            version: latest.version,
            changes: {
                latestVersion: 4,
                fileCount: 3,
                display: "inline_expanded",
                updatedBy: latest.updatedBy,
            },
        });
        expect(events[3]!.payload).not.toHaveProperty("mutationId");
        expect(events[4]!.payload).toMatchObject({
            changes: { latestVersion: 5, display: "side" },
        });
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("names the bot an artifact was made for, and filters the catalog by it", async () => {
        const { gym, call } = await harness();
        const bot = (await gym.client.createBot({ name: "Report writer" })).bot;
        await call(gym.defaultSessionId, "create_artifact", {
            type: "html",
            title: "Project page",
        });
        const created = await call(bot.agent.id, "create_artifact", {
            type: "markdown",
            title: "Revenue notes",
        });
        expect(created.text).toContain('Artifact created: "Revenue notes"');

        const byBot = await gym.client.listArtifacts({ sourceKind: "bot", sourceId: bot.id });
        expect(byBot.artifacts).toHaveLength(1);
        expect(byBot.artifacts[0]).toMatchObject({
            type: "markdown",
            entry: { path: "index.md", mimeType: "text/markdown" },
            source: { kind: "bot", botId: bot.id, agentId: bot.agent.id },
            createdBy: { kind: "agent", agentId: bot.agent.id, botId: bot.id },
        });
        expect(
            (
                await gym.client.listArtifacts({ authorKind: "agent", authorId: bot.agent.id })
            ).artifacts.map((artifact) => artifact.title),
        ).toEqual(["Revenue notes"]);
        expect(
            (await gym.client.listArtifacts({ agentId: gym.defaultSessionId })).artifacts.map(
                (artifact) => artifact.title,
            ),
        ).toEqual(["Project page"]);

        // The catalog is global: an agent anywhere lists what any other made.
        const listed = await call(bot.agent.id, "list_artifacts", {});
        expect(listed.text).toContain("Project page");
        expect(listed.text).toContain("Revenue notes");
    });
});
