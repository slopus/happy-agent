import type { HappyReference } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import type {
    HappySessionEvent,
    HappySessionProtocolMessage,
} from "../../sources/happy/HappyProtocol.js";
import { renderHappyMessageReferences } from "../../sources/happy/renderHappyMessageReferences.js";
import { resolveHappyReferenceLabel } from "../../sources/happy/resolveHappyReferenceLabel.js";
import { ArtifactNotFoundError } from "../../sources/artifacts/index.js";

function message(role: "agent" | "user", ev: HappySessionEvent): HappySessionProtocolMessage {
    return {
        content: { ev, id: "m", role, time: 1 },
        localId: "rig:m",
        meta: { sentFrom: "rig" },
        role: "session",
    };
}

function textOf(rendered: readonly HappySessionProtocolMessage[]): string[] {
    return rendered.map(({ content: { ev } }) => ("text" in ev ? ev.text : ev.t));
}

describe("renderHappyMessageReferences", () => {
    it("names each tag in the agent's words once, and leaves everything else as written", async () => {
        const asked: string[] = [];
        const label = async (reference: HappyReference) => {
            asked.push(reference.id);
            return reference.id === "known" ? "Q3 [draft]" : undefined;
        };
        const rendered = await renderHappyMessageReferences(
            [
                message("agent", {
                    t: "text",
                    text: 'See <happy-artifact id="known"/> and <happy-artifact  id="known" />.',
                }),
                message("agent", { t: "service", text: 'Lost <happy-agent id="gone"/>.' }),
                message("agent", { t: "text", text: 'Code: `<happy-artifact id="known"/>`' }),
                message("user", { t: "text", text: '<happy-artifact id="known"/>' }),
                message("agent", {
                    call: "c",
                    result: '<happy-artifact id="known"/>',
                    t: "tool-call-end",
                }),
            ],
            label,
        );

        expect(textOf(rendered)).toEqual([
            "See Q3 \\[draft\\] and Q3 \\[draft\\].",
            "Lost an unavailable agent.",
            'Code: `<happy-artifact id="known"/>`',
            '<happy-artifact id="known"/>',
            "tool-call-end",
        ]);
        expect(asked).toEqual(["known", "gone"]);
    });

    it("names the artifacts in tool-call rows as plain words, sharing the lookups", async () => {
        const asked: string[] = [];
        const start = (call: string, description: string): HappySessionProtocolMessage =>
            message("agent", {
                args: {},
                call,
                description,
                name: "update_artifact",
                t: "tool-call-start",
                title: "Update Artifact",
            });
        const untouched = start("c3", "Listing artifacts");
        const rendered = await renderHappyMessageReferences(
            [
                start("c1", 'Updating <happy-artifact id="known"/>'),
                message("agent", { t: "text", text: 'Done: <happy-artifact id="known"/>.' }),
                start("c2", 'Deleting <happy-artifact id="gone"/>'),
                untouched,
            ],
            async (reference) => {
                asked.push(reference.id);
                return reference.id === "known" ? "Q3 [draft]" : undefined;
            },
        );

        expect(
            rendered.map(({ content: { ev } }) =>
                ev.t === "tool-call-start" ? ev.description : "text" in ev ? ev.text : ev.t,
            ),
        ).toEqual([
            "Updating Q3 [draft]",
            "Done: Q3 \\[draft\\].",
            "Deleting an unavailable artifact",
            "Listing artifacts",
        ]);
        expect(rendered[3]).toBe(untouched);
        expect(asked).toEqual(["known", "gone"]);
    });

    it("turns the agent's file links into their labels, alongside its tags", async () => {
        const link = "happy-file://agents/a1b2/packages/app/Foo.tsx#L42";
        const original = message("agent", { t: "text", text: "Nothing to rewrite." });
        const rendered = await renderHappyMessageReferences(
            [
                message("agent", {
                    t: "text",
                    text: `See [Foo.tsx:42](${link}) in <happy-agent id="known"/>.`,
                }),
                message("agent", { t: "service", text: `Report: [\`a.ts\`](${link})` }),
                message("agent", { t: "text", text: `Code: \`[Foo](${link})\`` }),
                message("user", { t: "text", text: `[Foo](${link})` }),
                original,
            ],
            async () => "Fix login",
        );

        expect(textOf(rendered)).toEqual([
            "See Foo.tsx:42 in Fix login.",
            "Report: `a.ts`",
            `Code: \`[Foo](${link})\``,
            `[Foo](${link})`,
            "Nothing to rewrite.",
        ]);
        expect(rendered[4]).toBe(original);
    });
});

describe("resolveHappyReferenceLabel", () => {
    const catalogs = {
        agents: {
            config: async (_ctx: unknown, id: string) =>
                ({
                    "agent-bot": { metadata: {} },
                    "agent-task": { metadata: {} },
                    "agent-titled": { metadata: { title: "Fix the login loop" } },
                    "agent-untitled": { metadata: {} },
                    "agent-archived": { metadata: { title: "Old", archivedAt: 1 } },
                })[id],
        },
        artifacts: {
            get: async (_ctx: unknown, id: string) =>
                ({
                    live: { id: "live", status: "active", title: "Report v2" },
                    deleted: { id: "deleted", status: "deleted", title: "Gone" },
                })[id],
            getVersion: async (_ctx: unknown, _id: string, version: number) => {
                if (version === 1) return { title: "Report v1" };
                throw new ArtifactNotFoundError("The version was not found.");
            },
        },
        bots: {
            forAgent: async (_ctx: unknown, id: string) =>
                id === "agent-bot" ? { name: "Research Assistant" } : undefined,
        },
        tasks: {
            forAgent: async (_ctx: unknown, id: string) =>
                id === "agent-task" ? { name: "Fix login redirect" } : undefined,
        },
        projects: {
            get: async (_ctx: unknown, id: string) =>
                ({
                    rig: { name: "rig", status: "active" },
                    old: { name: "old", status: "archived" },
                })[id],
        },
        workspaces: {
            get: async (_ctx: unknown, id: string) =>
                ({
                    fix: { name: "fix-login", status: "initializing" },
                    done: { name: "done", status: "archived" },
                })[id],
        },
    };
    const label = (reference: HappyReference) =>
        resolveHappyReferenceLabel({} as never, catalogs as never, reference);

    it("reads the live name a client would show, and nothing for what renders inert", async () => {
        const cases: [HappyReference, string | undefined][] = [
            [{ kind: "artifact", id: "live" }, "Report v2"],
            [{ kind: "artifact", id: "live", version: 1 }, "Report v1"],
            [{ kind: "artifact", id: "live", version: 9 }, undefined],
            [{ kind: "artifact", id: "deleted" }, undefined],
            [{ kind: "artifact", id: "missing" }, undefined],
            [{ kind: "agent", id: "agent-bot" }, "Research Assistant"],
            [{ kind: "agent", id: "agent-task" }, "Fix login redirect"],
            [{ kind: "agent", id: "agent-titled" }, "Fix the login loop"],
            [{ kind: "agent", id: "agent-untitled" }, "an untitled conversation"],
            [{ kind: "agent", id: "agent-archived" }, undefined],
            [{ kind: "agent", id: "missing" }, undefined],
            [{ kind: "workspace", id: "fix" }, "fix-login"],
            [{ kind: "workspace", id: "done" }, undefined],
            [{ kind: "workspace", id: "rig" }, "rig"],
            [{ kind: "project", id: "rig" }, "rig"],
            [{ kind: "project", id: "old" }, undefined],
            [{ kind: "service", id: "rig" }, undefined],
            [{ kind: "future", id: "rig" }, undefined],
        ];
        for (const [reference, expected] of cases) {
            expect([reference, await label(reference)]).toEqual([reference, expected]);
        }
    });
});
