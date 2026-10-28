import { expect, it } from "vitest";
import type { AgentModuleHooks, AgentSystemRef } from "@slopus/happy-agent-base";

import { SpacesModule, spaceMigrations, type SpaceRecord } from "../../sources/spaces/index.js";
import {
    insertSpace,
    queryOwnerState,
    writeOwnerState,
} from "../../sources/spaces/persistence/SpacesPersistence.js";
import { formatConversationBrief } from "../../sources/spaces/impl/formatConversationBrief.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const OWNER = "standalone";
const STEM = "agentstemaaaaaaaaaaaaaaa";
const REVIEW = "agentreviewaaaaaaaaaaaaa";
const PLAIN = "agentplainaaaaaaaaaaaaaa";
const PRIORITIZING = "agentprioaaaaaaaaaaaaaaa";

type Params = ConstructorParameters<typeof SpacesModule>;
type Accepted = Parameters<NonNullable<AgentModuleHooks["messageAcceptedTransact"]>>[2];

function row(id: string, agentId: string, fresh = false): SpaceRecord {
    return {
        id,
        ownerUserId: OWNER,
        role: "item",
        icon: fresh ? { type: "stem_cell" } : { type: "library", slug: "code" },
        contents: [{ kind: "task", taskId: `task${id.slice(4)}`, agentId }],
        orderKey: "1",
        placement: "pending",
        visibility: "shown",
        ...(fresh ? {} : { briefedAt: 1 }),
        version: 1,
        createdAt: 1,
        updatedAt: 1,
    };
}

/** Spaces with every collaborator stubbed except the database it keeps its own state in. */
async function setup(team: unknown = { enabled: false }) {
    const database = moduleDatabase(spaceMigrations, "conversation-briefs");
    await database.ready;
    const invoked: { arguments: { text: string } }[] = [];
    const replies = new Map<string, string[]>();
    // Focus is a subtask too; without its own row, its messages must not count as a session.
    const parents = new Map<string, string>([
        [REVIEW, STEM],
        [PRIORITIZING, PLAIN],
    ]);
    const spaces = new SpacesModule(
        { configuration: { values: { feature: { team: { enabled: false } } } } } as Params[0],
        {} as Params[1],
        {} as Params[2],
        {} as Params[3],
        {
            read: async (_ctx: unknown, agentId: string) => ({
                messages: (replies.get(agentId) ?? []).map((text) => ({
                    message: { role: "assistant", blocks: [{ type: "text", text }] },
                })),
            }),
        } as unknown as Params[4],
        {} as Params[5],
        {
            register: () => undefined,
            invoke: async (_ctx: unknown, call: { arguments: { text: string } }) => {
                invoked.push(call);
            },
        } as unknown as Params[6],
        {} as Params[7],
        team as unknown as Params[8],
        { get: async () => ({ value: true }) } as unknown as Params[9],
        {
            // Only work started as a stem cell, and what runs under it, is named by subject.
            namingStyle: async (_ctx: unknown, agentId: string) =>
                agentId === STEM || agentId === REVIEW ? "subject" : "standard",
        } as unknown as Params[10],
    );
    const hooks = spaces.beforeStart(database.context, {
        config: async (_ctx: unknown, id: string) => ({ id, metadata: {} }),
        parentOf: async (_ctx: unknown, id: string) => parents.get(id) ?? null,
    } as unknown as AgentSystemRef);
    await writeOwnerState(database.context, {
        ownerUserId: OWNER,
        sidebarArtifactId: "artifactaaaaaaaaaaaaaaaa",
        prioritizingAgentId: PRIORITIZING,
    });
    await insertSpace(database.context, row("spacestemaaaaaaaaaaaaaaa", STEM));
    await insertSpace(database.context, row("spaceplainaaaaaaaaaaaaaa", PLAIN));
    const send = async (agentId: string, text: string, origin = "user", userId?: string) =>
        await hooks.messageAcceptedTransact!(
            database.context,
            { agent: { id: agentId } } as Parameters<
                NonNullable<AgentModuleHooks["messageAcceptedTransact"]>
            >[1],
            {
                message: { role: "user", content: [{ type: "text", text }] },
                metadata: { messageOrigin: origin, ...(userId === undefined ? {} : { userId }) },
            } as unknown as Accepted,
        );
    const briefs = async () => (await queryOwnerState(database.context, OWNER))?.sidebarBrief ?? [];
    const wakeAt = async () => (await queryOwnerState(database.context, OWNER))?.sidebarWakeAt;
    return { database, spaces, hooks, replies, invoked, send, briefs, wakeAt };
}

it("forwards the person's messages in every conversation with the agent's reply before each", async () => {
    const h = await setup();
    try {
        h.replies.set(STEM, ["Which platform first?", "", "Which platform first, iOS or Android?"]);
        await h.send(STEM, "Android first, the beta is due Friday.");
        expect(await h.briefs()).toEqual([
            [
                "Conversation in spacestemaaaaaaaaaaaaaaa: the person wrote in row spacestemaaaaaaaaaaaaaaa.",
                "Agent before it: Which platform first, iOS or Android?",
                "Person: Android first, the beta is due Friday.",
            ].join("\n"),
        ]);
        // Messages an agent sent are not forwarded.
        await h.send(STEM, "Status of the subtask: done.", "agent");
        expect(await h.briefs()).toHaveLength(1);
        // Work that did not start as a stem cell is forwarded too: what the person says anywhere
        // is what Focus prioritizes by.
        await h.send(PLAIN, "Rename the release branch.");
        expect((await h.briefs()).at(-1)).toBe(
            [
                "Conversation in spaceplainaaaaaaaaaaaaaa: the person wrote in row spaceplainaaaaaaaaaaaaaa.",
                "Person: Rename the release branch.",
            ].join("\n"),
        );
        // Writing to Focus itself is a request to it, never a notice about another row.
        await h.send(PRIORITIZING, "This week: the Android beta.");
        expect(await h.briefs()).toHaveLength(2);
        // A session under stem-cell work is forwarded under its row.
        h.replies.set(REVIEW, ["The patch is ready for your review."]);
        await h.send(REVIEW, "Looks good, merge it.");
        expect((await h.briefs()).at(-1)).toBe(
            [
                "Conversation in spacestemaaaaaaaaaaaaaaa: the person wrote in session agentreviewaaaaaaaaaaaaa under row spacestemaaaaaaaaaaaaaaa.",
                "Agent before it: The patch is ready for your review.",
                "Person: Looks good, merge it.",
            ].join("\n"),
        );
        // Work still waiting for its first placement wakes Prioritizing, since a message may make
        // its subject clear; the brief itself follows after the commit, so nothing was sent yet.
        expect(await h.wakeAt()).toBeTypeOf("number");
        expect(h.invoked).toEqual([]);
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("wakes Prioritizing under a teammate's name when someone else writes in the person's work", async () => {
    const steve = "steveuseraaaaaaaaaaaaaaa";
    const users = new Map([
        [OWNER, { id: OWNER, authentication: "jwt", firstName: "Kirill", lastName: null }],
        [steve, { id: steve, authentication: "jwt", firstName: "Steve", lastName: null }],
    ]);
    const h = await setup({
        enabled: true,
        getUser: async (_ctx: unknown, id: string) => users.get(id),
        connectionContext: (ctx: unknown) => ctx,
    });
    try {
        // The work has been placed, so the person's own messages in it no longer wake anything.
        const state = (await queryOwnerState(h.database.context, OWNER))!;
        await writeOwnerState(h.database.context, {
            ...state,
            sidebarPlacedIds: ["spaceplainaaaaaaaaaaaaaa"],
        });
        h.replies.set(PLAIN, ["Shipped: the waveform is on main."]);
        // The person's own message in placed work waits for the next brief.
        await h.send(PLAIN, "Nice.", "user", OWNER);
        expect((await h.briefs()).at(-1)).toContain("the person wrote in row");
        expect(await h.wakeAt()).toBeUndefined();
        // A teammate's is news to the person: it names them and wakes Prioritizing.
        await h.send(PLAIN, "Great!", "user", steve);
        expect((await h.briefs()).at(-1)).toBe(
            [
                "Conversation in spaceplainaaaaaaaaaaaaaa: their teammate Steve wrote in row spaceplainaaaaaaaaaaaaaa, not the person.",
                "Agent before it: Shipped: the waveform is on main.",
                "Steve: Great!",
            ].join("\n"),
        );
        expect(await h.wakeAt()).toBeTypeOf("number");
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("keeps only the latest few notices of one conversation, each bounded", async () => {
    const h = await setup();
    try {
        h.replies.set(STEM, ["x".repeat(5_000)]);
        for (const n of [1, 2, 3, 4, 5])
            await h.send(STEM, `Message ${String(n)} ${"y".repeat(5_000)}`);
        const kept = await h.briefs();
        expect(kept.map((brief) => /Person: (Message \d)/.exec(brief)?.[1])).toEqual([
            "Message 3",
            "Message 4",
            "Message 5",
        ]);
        for (const brief of kept) expect(brief.length).toBeLessThan(1_500);
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("wakes Prioritizing with new work's first message, whoever wrote it", async () => {
    const h = await setup();
    try {
        await insertSpace(
            h.database.context,
            row("spacefreshaaaaaaaaaaaaaa", "agentfreshaaaaaaaaaaaaaa", true),
        );
        await h.send("agentfreshaaaaaaaaaaaaaa", "Plan the Android beta.");
        expect((await h.briefs()).join("\n")).toContain("Plan the Android beta.");
        expect(await h.wakeAt()).toBeTypeOf("number");
        // Work another agent created has no stem-cell icon, and its first message is the agent's.
        const { icon: _icon, ...created } = row(
            "spacemadeaaaaaaaaaaaaaaa",
            "agentmadeaaaaaaaaaaaaaaa",
            true,
        );
        await insertSpace(h.database.context, created);
        await h.send("agentmadeaaaaaaaaaaaaaaa", "Fix the Telegram webhook retries.", "agent");
        await h.send("agentmadeaaaaaaaaaaaaaaa", "Also check the logs.", "agent");
        const briefs = await h.briefs();
        expect(briefs.filter((brief) => brief.includes("spacemadeaaaaaaaaaaaaaaa"))).toEqual([
            expect.stringContaining("Fix the Telegram webhook retries."),
        ]);
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("tells Prioritizing of a new session as a fact, without suggesting it be shown", async () => {
    const h = await setup();
    try {
        type Created = Parameters<NonNullable<AgentModuleHooks["agentCreatedTransact"]>>;
        await h.hooks.agentCreatedTransact!(
            h.database.context,
            {} as Created[1],
            {
                id: REVIEW,
                metadata: { title: "Review patch" },
            } as unknown as Created[2],
        );
        expect(await h.briefs()).toEqual([
            `New session ${REVIEW} "Review patch" started under row spacestemaaaaaaaaaaaaaaa.`,
        ]);
    } finally {
        await h.spaces.close();
        h.database.close();
    }
});

it("describes a session that stopped with its last reply", () => {
    expect(
        formatConversationBrief({
            rowId: "row",
            sessionId: "session",
            agentText: "Ready  for\n your review.",
        }),
    ).toBe(
        "Conversation in row: session session under row row stopped. Its last reply: Ready for your review.",
    );
});
