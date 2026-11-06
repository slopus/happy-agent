import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import type { HappyAgentClient, SearchResponse } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it, vi } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

async function upload(client: HappyAgentClient, text: string) {
    const bytes = new TextEncoder().encode(text);
    const created = (await client.createVaultUpload({ size: bytes.length })).upload;
    await client.uploadVaultChunk(created.id, { data: bytes, start: 0, size: bytes.length });
    return created.id;
}

const keys = (response: SearchResponse) => response.results.map((result) => result.key);

describe("search through the real daemon", () => {
    it("finds every kind of thing by its words and fuses them into one ranked list", async () => {
        const gym = await createAgentGym({
            permissionMode: "full_access",
            timeoutMs: 20000,
            inference: [
                {
                    content: [
                        { text: "The rocket is fueled.", type: "text" },
                        { text: "Countdown starts at noon.", type: "text" },
                    ],
                },
            ],
        });
        running.push(gym);
        const client = gym.client;
        const capabilities = (await client.getHealth()).capabilities;
        expect(capabilities?.search).toBe(true);
        expect(capabilities).not.toHaveProperty("quickSearch");
        expect(capabilities).not.toHaveProperty("vaultSearch");

        const studio = (await client.createSurface({ type: "vault", name: "Studio" })).surface;
        const archive = (await client.createSurface({ type: "vault", name: "Archive" })).surface;
        const plans = (
            await client.createVaultFolder(studio.id, { name: "Rocket plans", parentId: null })
        ).folder;
        const budget = (
            await client.createVaultFile(studio.id, {
                name: "budget.md",
                parentId: plans.id,
                uploadId: await upload(client, "Fuel\nThe rocket needs more fuel\n"),
            })
        ).file;
        const saturn = (
            await client.createVaultFile(archive.id, {
                name: "rockets of 1969.md",
                parentId: null,
                uploadId: await upload(client, "Saturn V"),
            })
        ).file;
        const list = (await client.createSurface({ type: "todo", name: "Errands" })).surface;
        const venue = (await client.createTodo(list.id, { text: "Book the rocket venue" })).todo;
        const calendar = (await client.createSurface({ type: "calendar", name: "Team" })).surface;
        const review = (
            await client.createCalendarEvent(calendar.id, {
                title: "Rocket review",
                location: "Hangar 4",
                timing: { kind: "allDay", startDate: "2026-08-31", endDate: "2026-09-01" },
            })
        ).event;
        const launches = (await client.createSurface({ type: "todo", name: "Rocket launches" }))
            .surface;
        const notes = (
            await client.createSurface({
                type: "document",
                name: "Notes",
                text: "# Notes\n\nThe rocket moves to Friday\n",
            })
        ).surface;
        const artifact = (
            await client.createArtifact({
                type: "markdown",
                title: "Rocket notes",
                files: [{ path: "index.md", text: "# Launch\n" }],
            })
        ).artifact;
        const bot = (await client.createBot({ name: "Rocket bot" })).bot;
        await gym.send("Check the rocket before launch.");

        // A document's text is indexed just after the edit.
        await vi.waitFor(
            async () => {
                expect(keys(await client.search({ q: "friday" }))).toEqual([
                    `document:${notes.id}`,
                ]);
            },
            { timeout: 10_000 },
        );

        const everything = await client.search({ q: "ROCK" });
        expect(everything).toMatchObject({ truncated: false, partial: false });
        expect(everything.results.map((result) => result.rank)).toEqual(
            everything.results.map((_result, index) => index + 1),
        );
        // What the person wrote and what the agent answered are messages of its conversation.
        const messages = everything.results.filter((result) => result.type === "message");
        expect(
            messages.map((result) => [result.agentId, result.role, result.snippet]).sort(),
        ).toEqual([
            [gym.defaultSessionId, "agent", "The rocket is fueled."],
            [gym.defaultSessionId, "user", "Check the rocket before launch."],
        ]);
        // Every text block of an answer is searchable, not only the first one written.
        expect((await client.search({ q: "countdown", types: ["message"] })).results).toMatchObject(
            [
                {
                    key: messages.find((result) => result.role === "agent")?.key,
                    snippet: "Countdown starts at noon.",
                },
            ],
        );
        // A finished answer matches all of a query's words, even when they sit in different blocks.
        await vi.waitFor(
            async () => {
                expect(
                    (await client.search({ q: "rocket countdown", types: ["message"] })).results,
                ).toMatchObject([
                    {
                        key: messages.find((result) => result.role === "agent")?.key,
                        snippet: "The rocket is fueled.",
                    },
                ]);
            },
            { timeout: 10_000 },
        );
        expect(new Set(keys(everything).filter((key) => !key.startsWith("message:")))).toEqual(
            new Set([
                `vault_folder:${plans.id}`,
                `vault_file:${saturn.id}`,
                `vault_file:${budget.id}`,
                `document:${notes.id}`,
                `todo:${venue.id}`,
                `calendar_event:${review.id}`,
                `artifact:${artifact.id}`,
                `surface:${launches.id}`,
                `agent:${bot.agent.id}`,
            ]),
        );
        // Each provider's best match takes a first-place score; ties go in provider order.
        expect(keys(everything).slice(0, 2)).toEqual([
            `vault_folder:${plans.id}`,
            `document:${notes.id}`,
        ]);
        expect(everything.results.find((result) => result.type === "agent")).toMatchObject({
            title: "Rocket bot",
            kind: "bot",
            archived: false,
            workspaceId: bot.agent.workspaceId,
            projectId: null,
        });
        // A vault file matched by its text says where; one matched by its name does not.
        expect(
            everything.results.find((result) => result.key === `vault_file:${saturn.id}`),
        ).toMatchObject({
            surfaceId: archive.id,
            match: "name",
            line: null,
            snippet: null,
        });
        expect(
            everything.results.find((result) => result.key === `vault_file:${budget.id}`),
        ).toMatchObject({
            surfaceId: studio.id,
            match: "content",
            line: 2,
            snippet: "The rocket needs more fuel",
        });
        expect(everything.results.find((result) => result.type === "calendar_event")).toMatchObject(
            { title: "Rocket review", allDay: true, start: Date.UTC(2026, 7, 31), match: "name" },
        );
        // An event's location is its content.
        expect((await client.search({ q: "hangar" })).results).toMatchObject([
            { key: `calendar_event:${review.id}`, match: "content", snippet: "Hangar 4" },
        ]);

        // `types` narrows the search, unknown types are ignored, and `limit` truncates.
        expect(keys(await client.search({ q: "rocket", types: ["todo", "future_type"] }))).toEqual([
            `todo:${venue.id}`,
        ]);
        expect(await client.search({ q: "rocket", types: ["future_type"] })).toEqual({
            results: [],
            truncated: false,
            partial: false,
        });
        const two = await client.search({ q: "rocket", limit: 2 });
        expect(two.results).toHaveLength(2);
        expect(two.truncated).toBe(true);

        // An HTML file is found by the text a reader sees, never by its markup.
        const page = (
            await client.createVaultFile(studio.id, {
                name: "briefing.html",
                parentId: null,
                uploadId: await upload(
                    client,
                    '<!doctype html><h1 class="zebra" style="color:teal">Mission &amp; <b>orbit</b></h1>\n<script>const giraffe = 1;</script>',
                ),
            })
        ).file;
        expect((await client.search({ q: "orbit" })).results).toMatchObject([
            { key: `vault_file:${page.id}`, match: "content", line: 1, snippet: "Mission & orbit" },
        ]);
        for (const q of ["zebra", "teal", "giraffe", "doctype"])
            expect(keys(await client.search({ q }))).toEqual([]);

        // Deleting takes a thing out at once.
        await client.deleteTodo(list.id, venue.id, { ifMatch: venue.version });
        expect(keys(await client.search({ q: "venue" }))).toEqual([]);

        // The body is JSON with exactly `q`, `types`, and `limit`.
        expect(
            (await gym.http.request("POST", "/v0/search", { q: "rocket", types: ["todo"] })).status,
        ).toBe(200);
        for (const body of [
            undefined,
            {},
            { q: "" },
            { q: "x".repeat(257) },
            { q: "x", types: [] },
            { q: "x", limit: 0 },
            { q: "x", limit: 101 },
            { q: "x", kind: "name" },
        ])
            expect((await gym.http.request("POST", "/v0/search", body)).status).toBe(400);
        // There is no GET form, and the routes search replaced are gone.
        for (const path of [
            "/v0/search?q=rocket",
            "/v0/quick-search?q=rocket",
            "/v0/vault-search?q=rocket",
            `/v0/surfaces/vault/${studio.id}/search?q=rocket`,
        ])
            expect((await gym.http.request("GET", path)).status).toBe(404);
        expect(gym.inference.unscripted).toEqual([]);
    }, 600_000);
});
