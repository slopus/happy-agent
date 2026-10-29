import { createAgentGym, frameEvent, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";
import { sidebarGym } from "./support/sidebarGym.js";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

/** One row as the daemon formats the document: one element a line, two spaces a level. */
const line = (id: string) => `  <happy-space id="${id}"/>\n`;
const separator = (id: string) => `  <happy-separator id="${id}"/>\n`;
const section = (id: string, label: string) => `  <happy-section id="${id}" label="${label}"/>\n`;

it("keeps queued markup when ordinary artifact tools change only metadata", async () => {
    const h = await sidebarGym();
    try {
        await h.read();
        await h.unseed();
        const initial = await h.read();
        const html = initial.html.replace("</nav>", `${separator("keep")}</nav>`);
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: initial.version,
                    edits: [{ oldText: "</nav>", newText: `${separator("keep")}</nav>` }],
                })
            ).text,
        ).toContain("queued");
        expect(
            (
                await h.call("update_artifact", {
                    artifactId: initial.artifactId,
                    baseVersion: initial.version + 1,
                    title: "Renamed sidebar",
                    background: "#ABC",
                })
            ).text,
        ).toContain("proposal accepted");
        await h.settle();
        const applied = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.version === initial.version + 2 ? doc : undefined;
        }, "both artifact versions");
        expect(applied.html).toBe(html);
        expect((await h.gym.client.getArtifact(initial.artifactId)).artifact).toMatchObject({
            title: "Renamed sidebar",
            background: "#abc",
        });
        expect(
            (await h.gym.client.listArtifactVersions(initial.artifactId)).versions.map(
                (version) => version.title,
            ),
        ).toEqual(["Renamed sidebar", "Sidebar", "Sidebar"]);
        await h.call("update_artifact", {
            artifactId: initial.artifactId,
            baseVersion: applied.version,
            title: "Sidebar final",
        });
        await h.settle();
        await h.gym.waitUntil(
            async () => ((await h.read()).version === applied.version + 1 ? true : undefined),
            "the metadata-only version",
        );
        expect((await h.read()).html).toBe(html);
        // Each turn's changes are one batch.
        expect(
            (await h.gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
        ).toHaveLength(3);
    } finally {
        await h.gym.dispose();
    }
}, 120000);

const running = new Set<AgentGym>();

it("lets Tidy move untouched rows after the person drags one row, and the person drag Search", async () => {
    const h = await sidebarGym();
    try {
        const first = await h.read();
        const happy = first.spaces.find((space) => space.title === "Happy")!;
        // Tasks made without the stem-cell flow have no activity, so Prioritizing may move them.
        const task = async () => (await h.gym.client.createTask({})).task.id;
        const made = [await task(), await task(), await task(), await task()];
        const rows = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            const ids = made.map(
                (taskId) => doc.spaces.find((space) => space.target.id === taskId)?.id,
            );
            return ids.every((id) => id !== undefined && doc.html.includes(id))
                ? (ids as string[])
                : undefined;
        }, "rows for the new tasks");
        const [redesign, lightbox, table, later] = rows as [string, string, string, string];
        await h.unseed();
        const arrange = (html: string, ids: string[]) =>
            rows
                .reduce((doc, id) => doc.replace(line(id), ""), html)
                .replace(line(happy.id), `${line(happy.id)}${ids.map(line).join("")}`);
        const initial = await h.read();
        const withDesktop = initial.html.replace("</nav>", `${separator("desktop")}</nav>`);
        const arranged = arrange(withDesktop, [redesign, lightbox, table, later]);
        expect((await h.edit(arranged)).text).toContain("queued");
        await h.settle();
        const seeded = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.html === arranged ? doc : undefined;
        }, "Prioritizing's arrangement");
        const dragged = arrange(arranged, [table, redesign, lightbox, later]);
        const current = await h.gym.http.ok<{ version: number }>("PUT", "/v0/spaces/sidebar", {
            html: dragged,
            baseVersion: seeded.version,
            mutationId: "drag-table-above-redesign",
        });
        expect(JSON.parse((await h.call("list_sidebar", {})).text)).toMatchObject({
            manualIds: [table],
        });
        const tidy = dragged
            .replace(line(lightbox), "")
            .replace(separator("desktop"), `${separator("desktop")}${line(lightbox)}`);
        expect((await h.edit(tidy)).text).toContain("queued");
        await h.settle();
        const applied = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.version === current.version + 1 ? doc : undefined;
        }, "Tidy moving the untouched Lightbox row");
        expect(applied.html).toBe(tidy);
        const undoDrag = tidy
            .replace(line(table), "")
            .replace(separator("desktop"), `${separator("desktop")}${line(table)}`);
        expect((await h.edit(undoDrag)).text).toContain("manual placement");
        const searchLast = tidy
            .replace("  <happy-search/>\n", "")
            .replace("</nav>", "  <happy-search/>\n</nav>");
        // The person may drag Search and Create like any other item.
        const moved = await h.gym.http.ok<{ html: string }>("PUT", "/v0/spaces/sidebar", {
            html: searchLast,
            baseVersion: applied.version,
            mutationId: "search-to-the-bottom",
        });
        expect(moved.html).toBe(searchLast);
    } finally {
        await h.gym.dispose();
    }
}, 120000);

it("keeps each person's sidebar references and ordinary writes owner-authorized", async () => {
    const { gym, alice, bob, aliceHttp, bobHttp } = await surfaceTeamClients({
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    running.add(gym);
    const own = await aliceHttp.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    const other = await bobHttp.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    expect(own.artifactId).not.toBe(other.artifactId);
    const resource = (await alice.getArtifact(own.artifactId)).artifact;
    const change = {
        baseVersion: own.version,
        files: [
            {
                path: "index.html",
                text: own.html.replace("</nav>", `${separator("bob")}</nav>`),
            },
        ],
    };
    await expect(
        bob.updateArtifact(own.artifactId, change, { ifMatch: resource.version }),
    ).rejects.toMatchObject({ status: 404 });
    const unknown = await bobHttp.request("PUT", "/v0/spaces/sidebar", {
        baseVersion: other.version,
        mutationId: "other-ref",
        html: other.html.replace("</nav>", `${line(own.spaces[0]!.id)}</nav>`),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toHaveProperty("diagnostics");
    expect((await aliceHttp.ok<Sidebar>("GET", "/v0/spaces/sidebar")).html).toBe(own.html);
}, 120000);
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});
type Sidebar = {
    artifactId: string;
    version: number;
    html: string;
    seed?: true;
    spaces: { id: string; title: string | null; target: { id: string; agentId: string | null } }[];
};
type StemCell = { space: { id: string; target: { id: string } }; agent: { id: string } };

it("validates every write, preserves CAS, replays mutations and persists sidebar versions", async () => {
    const gym = await createAgentGym({
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    running.add(gym);
    const get = () => gym.http.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    const initial = await get();
    expect(initial.seed).toBe(true);
    const html = initial.html.replace("</nav>", `${separator("shared")}</nav>`);
    const body = { html, baseVersion: initial.version, mutationId: "first-document".repeat(50) };
    const committed = await gym.http.ok<Sidebar>("PUT", "/v0/spaces/sidebar", body);
    expect(committed.version).toBe(initial.version + 1);
    expect(committed.seed).toBeUndefined();
    expect(await gym.http.ok("PUT", "/v0/spaces/sidebar", body)).toMatchObject({
        version: committed.version,
        html,
    });
    const retries = await Promise.all(
        Array.from({ length: 3 }, () => gym.http.ok<Sidebar>("PUT", "/v0/spaces/sidebar", body)),
    );
    expect(retries.map((document) => document.version)).toEqual([
        committed.version,
        committed.version,
        committed.version,
    ]);
    expect(
        (await gym.http.request("PUT", "/v0/spaces/sidebar", { ...body, mutationId: "stale" }))
            .status,
    ).toBe(409);
    const mismatch = await gym.http.request("PUT", "/v0/spaces/sidebar", {
        ...body,
        html: initial.html,
    });
    expect(mismatch.status).toBe(409);
    for (const invalid of [
        "<nav><happy-search/><happy-create/><script>alert(1)</script></nav>",
        '<nav><happy-search/><happy-create/><happy-space id="unknown"/></nav>',
        '<nav><happy-search/><happy-create/><p class="note">text</p></nav>',
        "<nav><happy-create/></nav>",
    ]) {
        const response = await gym.http.request("PUT", "/v0/spaces/sidebar", {
            html: invalid,
            baseVersion: committed.version,
            mutationId: "invalid",
        });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            diagnostics: [{ offset: expect.any(Number), message: expect.any(String) }],
        });
    }
    const artifact = (await gym.client.getArtifact(initial.artifactId)).artifact;
    const ordinary = {
        baseVersion: committed.version,
        files: [{ path: "index.html", text: "<nav><script></script></nav>" }],
    };
    await expect(
        gym.client.updateArtifact(initial.artifactId, ordinary, { ifMatch: artifact.version }),
    ).rejects.toMatchObject({ status: 400, body: { diagnostics: expect.any(Array) } });
    const extraFile = {
        baseVersion: committed.version,
        files: [{ path: "extra.html", text: "<p>extra</p>" }],
    };
    await expect(
        gym.client.updateArtifact(initial.artifactId, extraFile, { ifMatch: artifact.version }),
    ).rejects.toMatchObject({ status: 400, body: { diagnostics: expect.any(Array) } });
    expect((await get()).html).toBe(html);
    await gym.restart();
    expect(await get()).toMatchObject({
        artifactId: initial.artifactId,
        version: committed.version,
        html,
    });
    expect((await gym.client.listArtifactVersions(initial.artifactId)).versions).toHaveLength(2);
}, 120_000);

it("guards manual placements, versions each edit once, and no longer takes viewport reports", async () => {
    const h = await sidebarGym();
    try {
        const initial = await h.read();
        await h.gym.http.ok("PUT", "/v0/spaces/sidebar", {
            html: initial.html.replace("</nav>", `${separator("desktop")}</nav>`),
            baseVersion: initial.version,
            mutationId: "manual-separator",
        });
        const manual = await h.gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {
            sectionId: "desktop",
        });
        await h.gym.send("Work on the desktop.", { sessionId: manual.agent.id });
        let current = await h.read();
        // A refused move is dropped while the rest of its edit still queues, so every attempt
        // brings a separator of its own.
        let moves = 0;
        const moveAfterSeparator = (id: string) => ({
            baseVersion: current.version,
            edits: [
                { oldText: line(id), newText: "" },
                {
                    oldText: "</nav>",
                    newText: `${separator(`moved-${String(++moves)}`)}${line(id)}</nav>`,
                },
            ],
        });
        expect((await h.call("edit_sidebar", moveAfterSeparator(manual.space.id))).text).toContain(
            "manual placement",
        );
        await h.settle();
        current = await h.read();
        // A stale base applies only where its old text still occurs exactly once.
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: current.version - 1,
                    edits: [{ oldText: separator("stale"), newText: "" }],
                })
            ).text,
        ).toContain("sidebar changed");
        await h.settle();
        expect((await h.read()).version).toBe(current.version);

        // A stem cell keeps its icon until the person says what they want.
        const pending = await h.gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {});
        current = await h.read();
        expect(
            (await h.call("set_space_icon", { spaceId: pending.space.id, slug: "deploy" })).text,
        ).toContain("left alone");
        expect((await h.read()).spaces.find((row) => row.id === pending.space.id)?.icon).toEqual({
            type: "stem_cell",
        });
        await h.gym.send("Continue this work.", { sessionId: pending.agent.id });
        current = await h.read();
        const placed = moveAfterSeparator(pending.space.id);
        expect((await h.call("edit_sidebar", placed)).text).toContain("queued");
        await h.settle();
        await h.gym.waitUntil(
            async () => ((await h.read()).version > current.version ? true : undefined),
            "the first placement",
        );
        current = await h.read();
        expect((await h.call("read_artifact", { artifactId: current.artifactId })).text).toContain(
            "happy-separator",
        );
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: current.version,
                    edits: [{ oldText: "</nav>", newText: `${separator("first")}</nav>` }],
                })
            ).text,
        ).toContain("queued");
        expect(
            (
                await h.call("edit_sidebar", {
                    baseVersion: current.version + 1,
                    edits: [{ oldText: "</nav>", newText: `${separator("second")}</nav>` }],
                })
            ).text,
        ).toContain("queued");
        // Viewport reports are gone; an older desktop that still sends one gets an ordinary 404.
        expect(
            (
                await h.gym.http.post("/v0/spaces/sidebar/observations", {
                    visibleSpaceIds: [manual.space.id],
                })
            ).status,
        ).toBe(404);
        await h.settle();
        const applied = await h.gym.waitUntil(async () => {
            const doc = await h.read();
            return doc.version === current.version + 2 ? doc : undefined;
        }, "one version per accepted call");
        expect(applied.html).toContain(`${separator("first")}${separator("second")}</nav>`);
        // One batch per call that changed something: the first placement and the two separators.
        // The refused move of the person's row changed nothing.
        expect(
            (await h.gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
        ).toHaveLength(3);
    } finally {
        await h.gym.dispose();
    }
}, 120_000);

it("inserts a stem cell made under a separator right after it and removes archived rows", async () => {
    const gym = await createAgentGym({
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    running.add(gym);
    const get = () => gym.http.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    const initial = await get();
    await gym.http.ok("PUT", "/v0/spaces/sidebar", {
        html: initial.html.replace("</nav>", `${separator("desktop")}</nav>`),
        baseVersion: initial.version,
        mutationId: "separator",
    });
    const created = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {
        sectionId: "desktop",
    });
    const document = await get();
    expect(document.html).toContain(`${separator("desktop")}${line(created.space.id)}`);
    expect((await gym.http.post("/v0/spaces/stem-cells", { sectionId: "missing" })).status).toBe(
        404,
    );
    const task = (await gym.client.getTask(created.space.target.id)).task;
    await gym.client.archiveTask(task.id, { ifMatch: task.version });
    const archived = await gym.waitUntil(async () => {
        const doc = await get();
        return doc.html.includes(created.space.id) ? undefined : doc;
    }, "archive removal from the document");
    expect(archived.html).toContain(separator("desktop"));
    expect(
        (await gym.http.ok<{ batches: unknown[] }>("GET", "/v0/spaces/batches")).batches,
    ).toEqual([]);
}, 120_000);

it("Prioritizing files new work into a section with one edit and one live note in its own conversation", async () => {
    let latest: Sidebar | undefined;
    let target: string | undefined;
    let manual: string | undefined;
    let edited = false;
    const gym = await createAgentGym({
        timeoutMs: 30000,
        inference: (request) => {
            if (!request.instructions.includes("You are the Focus Agent"))
                return { content: [{ type: "text", text: "Done." }] };
            const last = request.messages.at(-1);
            const text = JSON.stringify(last);
            if (
                last?.role === "user" &&
                target !== undefined &&
                text.includes(`New work started in row ${target}`)
            )
                return { content: [{ type: "tool_call", name: "list_sidebar", arguments: {} }] };
            if (
                last?.role === "tool" &&
                text.includes("artifactId") &&
                latest !== undefined &&
                target !== undefined &&
                !edited
            ) {
                edited = true;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "edit_sidebar",
                            arguments: {
                                baseVersion: latest.version,
                                edits: [
                                    { oldText: line(target), newText: "" },
                                    {
                                        oldText: `${section("desktop", "Desktop")}${line(manual!)}`,
                                        newText: `${section("desktop", "Desktop")}${line(manual!)}${line(target)}`,
                                    },
                                ],
                            },
                        },
                    ],
                };
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    running.add(gym);
    await gym.client.saveUserSetting("happy-desktop.experiments.stemCells", { value: true });
    const get = () => gym.http.ok<Sidebar>("GET", "/v0/spaces/sidebar");
    const initial = await get();
    const happy = initial.spaces.find((space) => space.title === "Happy")!;
    await gym.http.ok("PUT", "/v0/spaces/sidebar", {
        html: initial.html.replace("</nav>", `${section("desktop", "Desktop")}</nav>`),
        baseVersion: initial.version,
        mutationId: "desktop",
    });
    const manualCell = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {
        sectionId: "desktop",
    });
    const created = await gym.http.ok<StemCell>("POST", "/v0/spaces/stem-cells", {});
    target = created.space.id;
    const task = (await gym.client.getTask(created.space.target.id)).task;
    await gym.client.renameTask(
        task.id,
        { name: "Windows installer signing" },
        { ifMatch: task.version },
    );
    manual = manualCell.space.id;
    latest = await get();
    const stream = gym.stream("/v0/events/stream");
    try {
        await stream.opened();
        await gym.send("Help with Windows installer signing.", { sessionId: created.agent.id });
        await gym.waitUntil(() => (edited ? true : undefined), "the manager's edit_sidebar call");
        await gym.waitUntil(
            () =>
                gym.inference.requests.some(
                    (request) =>
                        request.instructions.includes("You are the Focus Agent") &&
                        JSON.stringify(request.messages.at(-1)).includes(
                            "queued; it applies when this turn ends",
                        ),
                )
                    ? true
                    : undefined,
            "the queued exact edit",
        );
        const placed = await gym.waitUntil(async () => {
            const doc = await get();
            return doc.version > latest!.version ? doc : undefined;
        }, "the placement");
        expect(placed.version).toBe(latest.version + 1);
        expect(placed.html).toContain(
            `${section("desktop", "Desktop")}${line(manual)}${line(target)}`,
        );
        const batches = (
            await gym.http.ok<{ batches: { note: string; noteMessageId: string }[] }>(
                "GET",
                "/v0/spaces/batches",
            )
        ).batches;
        expect(batches).toHaveLength(1);
        expect(batches[0]!.note).toBe("Put Windows installer signing in Desktop.");
        await stream.waitFor((frame) => {
            const event = frameEvent(frame);
            return (
                event?.type === "message.created" &&
                JSON.stringify(event.payload).includes(batches[0]!.noteMessageId)
            );
        });
        const messages = async (agentId: string) =>
            (
                await gym.http.ok<{ runs: { messages: { id: string }[] }[] }>(
                    "GET",
                    `/v0/agents/${agentId}/messages`,
                )
            ).runs.flatMap((run) => run.messages);
        const prioritizing = gym.inference.requests.findLast((request) =>
            request.instructions.includes("You are the Focus Agent"),
        )!;
        // The note is Prioritizing's own; Happy's chat hears nothing.
        expect((await messages(prioritizing.sessionId!)).map((message) => message.id)).toContain(
            batches[0]!.noteMessageId,
        );
        expect(await messages(happy.target.agentId!)).toEqual([]);
        const tools = prioritizing.tools.map((tool) => tool.name);
        expect(tools).toContain("edit_sidebar");
        expect(tools).not.toContain("place_space");
    } finally {
        stream.close();
    }
}, 120_000);
