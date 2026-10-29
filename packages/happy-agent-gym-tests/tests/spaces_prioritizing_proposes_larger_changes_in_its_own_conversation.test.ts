import { runGymSql } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";

const line = (id: string) => `  <happy-space id="${id}"/>\n`;
const section = (id: string, label: string) => `  <happy-section id="${id}" label="${label}"/>\n`;

type Gym = Awaited<ReturnType<typeof sidebarGym>>;

/** Every message a conversation holds, oldest first. */
async function messages(h: Gym, agentId: string) {
    return (
        await h.gym.http.ok<{ runs: { messages: { id: string }[] }[] }>(
            "GET",
            `/v0/agents/${agentId}/messages`,
        )
    ).runs.flatMap((run) => run.messages);
}

/** The notices Prioritizing was woken with, as the text of each opening message. */
function wakes(h: Gym): string[] {
    return h.gym.inference.requests.flatMap((request) => {
        const last = request.messages.at(-1);
        const text = JSON.stringify(last);
        return request.instructions.includes("You are the Focus Agent") &&
            last?.role === "user" &&
            text.includes("Here is what changed since your last notice.")
            ? [text]
            : [];
    });
}

/** Whether Prioritizing was told this, in any request. */
function told(h: Gym, text: string): boolean {
    return h.gym.inference.requests.some(
        (request) =>
            request.instructions.includes("You are the Focus Agent") &&
            JSON.stringify(request.messages).includes(text),
    );
}

/** What Prioritizing reads: its view of the sidebar and its open proposal. */
async function view(h: Gym) {
    return JSON.parse((await h.call("list_sidebar", {})).text) as {
        version: number;
        html: string;
        proposal: { artifactId: string; version: number; html: string } | null;
    };
}

it("shows its own row once, wakes once per burst of the person's changes, and never on its own writes", async () => {
    const h = await sidebarGym();
    try {
        const first = await h.read();
        const prioritizing = await h.manager();
        const happy = first.spaces.find((row) => row.title === "Happy")!;
        const own = first.spaces.find((row) => row.target.agentId === prioritizing)!;
        // The row exists, but only Prioritizing puts it in the document, even during the seed.
        expect(first.html).not.toContain(own.id);
        expect(first.seed).toBe(true);
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: first.version,
                    edits: [
                        { oldText: line(happy.id), newText: `${line(happy.id)}${line(own.id)}` },
                    ],
                })
            ).text,
        ).toContain("queued");
        await h.settle();
        const shown = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.html.includes(`${line(happy.id)}${line(own.id)}`) ? doc : undefined;
        }, "Prioritizing's own row");
        // Its note goes to its own conversation; Happy's chat hears nothing.
        const batches = await h.gym.http.ok<{ batches: { note: string; noteMessageId: string }[] }>(
            "GET",
            "/v0/spaces/batches",
        );
        expect(batches.batches.map((batch) => batch.note)).toEqual([
            "Added this conversation to your sidebar.",
        ]);
        expect((await messages(h, prioritizing)).map((message) => message.id)).toContain(
            batches.batches[0]!.noteMessageId,
        );
        expect(await messages(h, happy.target.agentId!)).toEqual([]);
        // A second copy or a move of its row is refused.
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: shown.version,
                    edits: [{ oldText: "</nav>", newText: `${line(own.id)}</nav>` }],
                })
            ).text,
        ).toContain("Duplicate ID");
        await h.settle();
        // Its own batch woke nothing.
        expect(wakes(h)).toEqual([]);

        await h.unseed();
        await h.settle();
        // An explicit set that changes nothing still makes the fold the person's.
        const open = await h.read();
        const kept = await h.gym.client.applySpaceSidebarOperations({
            mutationId: "keep-tasks-open",
            baseVersion: open.version,
            operations: [{ type: "set", id: "tasks", collapsed: false }],
        });
        expect(kept.version).toBe(open.version);
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: open.version,
                    edits: [
                        {
                            oldText: section("tasks", "Tasks"),
                            newText:
                                '  <happy-section id="tasks" label="Tasks" collapsed="true"/>\n',
                        },
                    ],
                })
            ).text,
        ).toContain("Keep the person's own folds");
        await h.settle();

        // The person makes three changes at once: one wake, naming all three.
        const start = await h.read();
        expect(start.version).toBe(open.version);
        for (const [index, id] of ["bots", "tasks", "divider"].entries())
            await h.gym.client.applySpaceSidebarOperations({
                mutationId: `burst-${String(index)}`,
                baseVersion: start.version + index,
                operations:
                    id === "divider"
                        ? [{ type: "remove", id }]
                        : [{ type: "set", id, collapsed: true }],
            });
        const burst = await h.gym.waitUntil(
            () => (wakes(h).length > 0 ? wakes(h) : undefined),
            "the wake for the person's changes",
        );
        expect(burst).toHaveLength(1);
        for (const id of ["bots", "tasks", "divider"]) expect(burst[0]).toContain(id);
        await h.settle();
        expect(wakes(h)).toHaveLength(1);
    } finally {
        await h.gym.dispose();
    }
}, 120_000);

it("proposes a reorganisation the person edits and accepts, archives what it offered, and leaves the sidebar alone on decline", async () => {
    const h = await sidebarGym();
    try {
        const initial = await h.read();
        const happy = initial.spaces.find((row) => row.title === "Happy")!;
        await h.unseed();
        // Two tasks made outside the stem-cell flow have no activity yet.
        const made = [
            (await h.gym.client.createTask({ name: "Release notes" })).task.id,
            (await h.gym.client.createTask({ name: "Old spike" })).task.id,
        ];
        const [ship, spike] = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            const ids = made.map((id) => doc.spaces.find((row) => row.target.id === id)?.id);
            return ids.every((id) => id !== undefined && doc.html.includes(id))
                ? (ids as [string, string])
                : undefined;
        }, "rows for both tasks");
        await h.settle();
        const before = await view(h);
        expect(before.proposal).toBeNull();
        // A new section is a proposal: the live sidebar stays as it is.
        const proposed = await h.call("propose_sidebar", {
            baseVersion: before.version,
            edits: [
                { oldText: line(ship), newText: "" },
                { oldText: line(spike), newText: "" },
                {
                    oldText: "</nav>",
                    newText: `${section("releases", "Releases")}${line(ship)}${section("archive", "Archive")}${line(spike)}</nav>`,
                },
            ],
        });
        expect(proposed.text).toMatch(/^Proposal [a-z0-9]+ is at version 2\./);
        expect(proposed.text).not.toContain("<happy-artifact");
        const live = await h.read();
        expect(live.html).toBe(before.html);
        const { proposal } = await h.gym.http.ok<{
            proposal: { artifactId: string; status: string };
        }>("GET", "/v0/spaces/sidebar");
        expect(proposal.status).toBe("open");
        const artifact = (await h.gym.client.getArtifact(proposal.artifactId)).artifact;
        expect(artifact).toMatchObject({ type: "sidebar_proposal", display: "inline_expanded" });

        // The person renames the section in the proposal; that wakes Prioritizing.
        const draft = await h.gym.client.getSpaceSidebarProposal(proposal.artifactId);
        expect(draft.html).toContain(`${section("archive", "Archive")}${line(spike)}`);
        await h.gym.client.applySpaceSidebarProposalOperations(proposal.artifactId, {
            mutationId: "rename-releases",
            baseVersion: draft.proposal.version,
            operations: [{ type: "set", id: "releases", label: "Shipping" }],
        });
        await h.gym.waitUntil(
            () =>
                told(h, `The person edited your proposal ${proposal.artifactId}`)
                    ? true
                    : undefined,
            "the proposal edit notice",
        );
        await h.settle();
        // A revision keeps the person's edit.
        const revising = (await view(h)).proposal!;
        expect(
            (
                await h.call("propose_sidebar", {
                    baseVersion: revising.version,
                    edits: [{ oldText: 'label="Shipping"', newText: 'label="Releases"' }],
                })
            ).text,
        ).toContain("Keep the person's edit of this proposal.");
        expect((await h.read()).html).toBe(before.html);

        // Accepting applies it as the person's change and archives the offered task.
        const accepted = await h.gym.client.acceptSpaceSidebarProposal(proposal.artifactId, {
            mutationId: "accept-1",
        });
        expect(accepted.proposal.status).toBe("accepted");
        expect(accepted.archived).toEqual([spike]);
        expect(accepted.sidebar.html).toContain(`${section("releases", "Shipping")}${line(ship)}`);
        expect(accepted.sidebar.html).not.toContain('id="archive"');
        expect(
            await h.gym.client.acceptSpaceSidebarProposal(proposal.artifactId, {
                mutationId: "accept-1",
            }),
        ).toMatchObject({ sidebar: { version: accepted.sidebar.version } });
        const after = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.html.includes(spike) ? undefined : doc;
        }, "the archived task leaving the sidebar");
        expect(after.html).toContain(`${section("releases", "Shipping")}${line(ship)}`);
        expect((await h.gym.client.getTask(made[1]!)).task.archivedAt).toEqual(expect.any(Number));
        await h.gym.waitUntil(
            () =>
                told(h, `accepted your sidebar proposal ${proposal.artifactId}`) ? true : undefined,
            "the acceptance notice",
        );
        await h.settle();
        // What the person accepted is theirs: Prioritizing may not move it back.
        expect((await h.edit(before.html)).text).toContain("manual placement");

        // A declined proposal changes nothing.
        const current = await view(h);
        const second = await h.call("propose_sidebar", {
            baseVersion: current.version,
            edits: [{ oldText: "</nav>", newText: '  <happy-separator id="later"/>\n</nav>' }],
        });
        const secondId = /^Proposal ([a-z0-9]+) /.exec(second.text)![1]!;
        expect(secondId).not.toBe(proposal.artifactId);
        const sidebarBefore = await h.read();
        const declined = await h.gym.client.declineSpaceSidebarProposal(secondId, {});
        expect(declined.proposal.status).toBe("declined");
        await h.gym.waitUntil(
            () => (told(h, `declined your sidebar proposal ${secondId}`) ? true : undefined),
            "the decline notice",
        );
        await h.settle();
        const unchanged = await h.read();
        expect(unchanged.version).toBe(sidebarBefore.version);
        expect(unchanged.html).toBe(sidebarBefore.html);
        expect(unchanged).not.toHaveProperty("proposal");
        expect(await messages(h, happy.target.agentId!)).toEqual([]);
    } finally {
        await h.gym.dispose();
    }
}, 180_000);

it("tells an upgraded Prioritizing once and proposes what it may no longer apply", async () => {
    // Told of the update, Prioritizing tries to reshuffle on its own, then proposes the same.
    let reshuffle:
        | { baseVersion: number; edits: { oldText: string; newText: string }[] }
        | undefined;
    const h: Gym = await sidebarGym({
        prioritizing: async (request) => {
            const last = request.messages.at(-1);
            const text = JSON.stringify(last);
            if (
                last?.role === "user" &&
                text.includes("Happy Agent was updated.") &&
                reshuffle === undefined
            ) {
                const current = await h.read();
                reshuffle = {
                    baseVersion: current.version,
                    edits: [
                        {
                            oldText: current.html,
                            newText: current.html
                                .replace(section("bots", "Bots"), "")
                                .replace("</nav>", `${section("bots", "Bots")}</nav>`),
                        },
                    ],
                };
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "edit_sidebar",
                            arguments: reshuffle,
                            callId: "upgrade-edit",
                        },
                    ],
                };
            }
            if (last?.role === "tool" && text.includes("upgrade-edit"))
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "propose_sidebar",
                            arguments: reshuffle,
                            callId: "upgrade-propose",
                        },
                    ],
                };
            return undefined;
        },
    });
    try {
        await h.read();
        const prioritizing = await h.manager();
        await h.unseed();
        await h.settle();
        const happy = (await h.read()).spaces.find((row) => row.title === "Happy")!;
        // The store an earlier release left: no row for Prioritizing and no proposals marker.
        await h.gym.restart({
            whileStopped: async () =>
                await runGymSql(h.gym.happyHome, [
                    "DELETE FROM happy_agent_module_spaces WHERE role = 'focus'",
                    "DELETE FROM happy_agent_migrations WHERE module_key = 'spaces' AND migration_key IN ('009-sidebar-proposals', '010-voice-row', '011-space-order-keys-renumbered')",
                ]),
        });
        await h.gym.waitUntil(
            () => (told(h, "Happy Agent was updated.") ? true : undefined),
            "the upgrade notice",
        );
        const result = (callId: string) =>
            h.gym.inference.toolResults().find((found) => found.callId === callId)?.text;
        const proposed = await h.gym.waitUntil(() => result("upgrade-propose"), "the proposal");
        await h.settle();
        // Reshuffling placed rows on its own is dropped; the same change as a proposal is kept.
        expect(result("upgrade-edit")).toContain("propose_sidebar");
        expect(proposed).toContain("Proposal");
        const upgraded = await h.read();
        expect(upgraded.html.indexOf('id="bots"')).toBeLessThan(
            upgraded.html.indexOf('id="tasks"'),
        );
        const pending = await h.gym.http.ok<{ proposal?: { status: string } }>(
            "GET",
            "/v0/spaces/sidebar",
        );
        expect(pending.proposal?.status).toBe("open");
        const own = upgraded.spaces.filter((row) => row.target.agentId === prioritizing);
        expect(own).toHaveLength(1);
        expect(own[0]!.icon).toEqual({ type: "library", slug: "goals" });
        // A restart tells it nothing twice.
        await h.gym.restart();
        await h.read();
        expect(
            h.gym.inference.requests.filter((request) =>
                JSON.stringify(request.messages.at(-1)).includes("Happy Agent was updated."),
            ),
        ).toHaveLength(1);
        expect((await h.read()).html).toBe(upgraded.html);
        expect(await messages(h, happy.target.agentId!)).toEqual([]);
    } finally {
        await h.gym.dispose();
    }
}, 180_000);

it("tells a failed run's notices again with the next wake", async () => {
    let failing = false;
    const h = await sidebarGym({
        prioritizing: (request) => {
            if (!failing || request.messages.at(-1)?.role !== "user") return undefined;
            if (!JSON.stringify(request.messages.at(-1)).includes("Here is what changed"))
                return undefined;
            failing = false;
            return { error: { message: "This provider has no credentials." } };
        },
    });
    try {
        await h.read();
        await h.unseed();
        await h.settle();
        const start = await h.read();
        failing = true;
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "fold-bots",
            baseVersion: start.version,
            operations: [{ type: "set", id: "bots", collapsed: true }],
        });
        await h.gym.waitUntil(() => (wakes(h).length === 1 ? true : undefined), "the failed wake");
        await h.settle();
        expect(failing).toBe(false);
        // A failure does not wake it again; the next event does, with both notices.
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "fold-tasks",
            baseVersion: start.version + 1,
            operations: [{ type: "set", id: "tasks", collapsed: true }],
        });
        const retold = await h.gym.waitUntil(
            () => (wakes(h).length === 2 ? wakes(h)[1] : undefined),
            "the next wake",
        );
        expect(retold).toContain("for: bots.");
        expect(retold).toContain("for: tasks.");
        await h.settle();
        // Once a run succeeded, nothing is owed any more.
        await h.gym.client.applySpaceSidebarOperations({
            mutationId: "open-bots",
            baseVersion: start.version + 2,
            operations: [{ type: "set", id: "bots", collapsed: false }],
        });
        const third = await h.gym.waitUntil(
            () => (wakes(h).length === 3 ? wakes(h)[2] : undefined),
            "the third wake",
        );
        expect(third).not.toContain("for: tasks.");
    } finally {
        await h.gym.dispose();
    }
}, 120_000);

it("wakes Prioritizing for work another agent created, with its title and first message", async () => {
    const h = await sidebarGym();
    try {
        const first = await h.read();
        const happy = first.spaces.find((row) => row.title === "Happy")!;
        await h.unseed();
        await h.settle();
        const created = await h.call(
            "create_task",
            { name: "Telegram retries", text: "Fix the Telegram webhook retries." },
            happy.target.agentId!,
        );
        expect(created.text).not.toMatch(/error|unknown/i);
        const row = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.spaces.find((space) => space.title === "Telegram retries");
        }, "the created task's row");
        await h.gym.waitUntil(
            () =>
                told(h, `New work started in row ${row.id}. Its first message:`) &&
                told(h, "Fix the Telegram webhook retries.")
                    ? true
                    : undefined,
            () =>
                `the first-message notice; created: ${created.text}; told: ${JSON.stringify(h.gym.inference.requests.filter((r) => r.instructions.includes("You are the Focus Agent")).map((r) => r.messages.at(-1)))}`,
        );
        expect(told(h, `New space ${row.id} \\"Telegram retries\\" was inserted below Happy`)).toBe(
            true,
        );
        // Prioritizing may place it: its first placement needs no proposal.
        const current = await view(h);
        const placed = current.html
            .replace(line(row.id), "")
            .replace(section("tasks", "Tasks"), `${section("tasks", "Tasks")}${line(row.id)}`);
        expect((await h.edit(placed)).text).toContain("queued");
        await h.settle();
        await h.gym.waitUntil(
            async () =>
                (await h.read()).html.includes(`${section("tasks", "Tasks")}${line(row.id)}`)
                    ? true
                    : undefined,
            "the placement",
        );
    } finally {
        await h.gym.dispose();
    }
}, 120_000);
