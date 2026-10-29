import type { AgentSystemRef } from "@slopus/happy-agent-base";
import { expect, it } from "vitest";

import { SpacesModule, spaceMigrations } from "../../sources/spaces/index.js";
import {
    insertSpace,
    writeOwnerState,
} from "../../sources/spaces/persistence/SpacesPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

type Params = ConstructorParameters<typeof SpacesModule>;

async function setup(title?: string) {
    const database = moduleDatabase(spaceMigrations, "focus-row");
    await database.ready;
    const titles = new Map<string, string | undefined>();
    if (title !== undefined) titles.set("existingfocus", title);
    const created: { title: string }[] = [];
    const happy = { id: "happybot", agentId: "happyagent", workspaceId: "happyworkspace" };
    const spaces = new SpacesModule(
        {
            models: [{ providerId: "codex", id: "test", defaultEffort: "high" }],
        } as unknown as Params[0],
        {} as Params[1],
        { chiefOfStaff: async () => happy } as unknown as Params[2],
        {} as Params[3],
        { latestUserOrFinalAssistantTextMessageAt: async () => undefined } as unknown as Params[4],
        { activeRunId: () => undefined } as unknown as Params[5],
        { register: () => undefined } as unknown as Params[6],
        {
            create: async (
                _ctx: unknown,
                _parent: string,
                input: { title: string },
                id: string,
            ) => {
                created.push(input);
                titles.set(id, input.title);
            },
        } as unknown as Params[7],
        { enabled: false } as unknown as Params[8],
        { get: async () => ({ value: true }) } as unknown as Params[9],
        {} as Params[10],
        {
            bindSpaces: () => undefined,
            readFile: async () => ({
                version: 1,
                bytes: new TextEncoder().encode("<nav><happy-search/><happy-create/></nav>"),
            }),
        } as unknown as Params[11],
    );
    spaces.beforeStart(database.context, {
        config: async (_ctx: unknown, id: string) =>
            titles.has(id) ? { id, metadata: { title: titles.get(id) } } : undefined,
    } as unknown as AgentSystemRef);
    await writeOwnerState(database.context, {
        ownerUserId: "standalone",
        sidebarArtifactId: "sidebar",
        ...(title === undefined ? {} : { prioritizingAgentId: "existingfocus" }),
    });
    await insertSpace(database.context, {
        id: "happyrow",
        ownerUserId: "standalone",
        role: "happy",
        contents: [{ kind: "bot", botId: happy.id, agentId: happy.agentId }],
        orderKey: "1",
        placement: "settled",
        visibility: "shown",
        version: 1,
        createdAt: 1,
        updatedAt: 1,
    });
    if (title !== undefined)
        await insertSpace(database.context, {
            id: "focusrow",
            ownerUserId: "standalone",
            role: "focus",
            contents: [{ kind: "agent", agentId: "existingfocus" }],
            orderKey: "2",
            placement: "settled",
            visibility: "shown",
            version: 1,
            createdAt: 1,
            updatedAt: 1,
        });
    return { database, spaces, created, titles };
}

it("creates a helper named Focus Agent, serves that name, and never inserts a row of its own itself", async () => {
    const h = await setup();
    try {
        // Reading the sidebar makes no helper; asking for a tidy with none does.
        await h.spaces.sidebar(h.database.context, "standalone");
        expect(h.created).toEqual([]);
        expect(await h.spaces.requestTidy(h.database.context, "standalone")).toBe(true);
        const sidebar = await h.spaces.sidebar(h.database.context, "standalone");
        expect(h.created).toMatchObject([{ title: "Focus Agent" }]);
        const focus = sidebar.spaces.find((row) => row.role === "focus")!;
        // Where the Focus Agent's row stands is its prompt's; the daemon never inserts it.
        expect(sidebar.html).not.toContain(focus.id);
        expect(await h.spaces.describe(h.database.context, focus)).toMatchObject({
            title: "Focus Agent",
            target: { kind: "agent" },
        });
        // An absent metadata title uses the new default without writing a stored title.
        const primary = focus.contents[0]!;
        if (primary.kind !== "agent") throw new Error("Expected Focus's agent row");
        const agentId = primary.agentId;
        h.titles.set(agentId, undefined);
        expect((await h.spaces.describe(h.database.context, focus)).title).toBe("Focus Agent");
        expect(h.titles.get(agentId)).toBeUndefined();
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it.each(["Prioritizing", "My organizer"])("keeps an existing helper's title %s", async (title) => {
    const h = await setup(title);
    try {
        const sidebar = await h.spaces.sidebar(h.database.context, "standalone");
        expect(h.created).toEqual([]);
        expect(h.titles.get("existingfocus")).toBe(title);
        const focus = sidebar.spaces.find((row) => row.role === "focus")!;
        expect((await h.spaces.describe(h.database.context, focus)).title).toBe(title);
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});
