import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArtifactAuthor, ArtifactType } from "../../sources/artifacts/index.js";
import { artifactsWorld, imageBytes, type ArtifactsWorld } from "./support/artifactsWorld.js";

const WRITER: ArtifactAuthor = { kind: "user", userId: "userdana" };

const worlds: ArtifactsWorld[] = [];
afterEach(async () => {
    for (const world of worlds.splice(0)) await world.close();
});

async function world(name: string): Promise<ArtifactsWorld> {
    const created = await artifactsWorld(name);
    worlds.push(created);
    return created;
}

async function create(
    w: ArtifactsWorld,
    type: ArtifactType,
    title: string,
    path: string,
    body: string | Uint8Array,
) {
    const upload =
        typeof body === "string"
            ? await w.artifacts.stageText(w.ctx, body)
            : await w.artifacts.stageUpload(w.ctx, body);
    return (
        await w.artifacts.create(w.ctx, {
            type,
            title,
            files: [{ path, uploadId: upload.id }],
            author: WRITER,
        })
    ).artifact;
}

describe("artifact search", () => {
    it("finds titles first, then newest text, and forgets deleted artifacts", async () => {
        const w = await world("artifact-search");
        const notes = await create(
            w,
            "markdown",
            "Release notes",
            "index.md",
            "# Q3\n\nThe launch moves to Friday\n",
        );
        const page = await create(
            w,
            "html",
            "Launch page",
            "index.html",
            "<html><head><style>.friday { color: red }</style></head>\n<body>\n<p>Doors open <b>Friday</b> at noon &amp; later</p>\n</body></html>",
        );
        await create(w, "image", "Friday poster", "poster.png", imageBytes("poster"));

        const search = async (q: string) =>
            (await w.artifacts.search(w.ctx, q, 10)).map((hit) => [
                hit.title,
                hit.match,
                hit.snippet,
            ]);
        // Titles first, then text: Markdown as written, HTML without tags, styles, or entities.
        expect(await search("friday")).toEqual([
            ["Friday poster", "name", null],
            ["Release notes", "content", "The launch moves to Friday"],
            ["Launch page", "content", "Doors open Friday at noon & later"],
        ]);
        expect(await search("LAUN")).toEqual([
            ["Launch page", "name", null],
            ["Release notes", "content", "The launch moves to Friday"],
        ]);
        expect(await w.artifacts.search(w.ctx, "release", 10)).toEqual([
            {
                type: "artifact",
                key: `artifact:${notes.id}`,
                artifactId: notes.id,
                title: "Release notes",
                artifactType: "markdown",
                match: "name",
                snippet: null,
            },
        ]);

        // Only the newest version's text is searched.
        await w.artifacts.update(w.ctx, {
            artifactId: notes.id,
            files: [
                {
                    path: "index.md",
                    uploadId: (await w.artifacts.stageText(w.ctx, "# Q4\n\nMoved to Monday\n")).id,
                },
            ],
            author: WRITER,
        });
        expect(await search("monday")).toEqual([["Release notes", "content", "Moved to Monday"]]);
        expect((await search("friday")).map(([title]) => title)).toEqual([
            "Friday poster",
            "Launch page",
        ]);

        // The summary is searched with the text, ahead of it.
        await w.artifacts.update(w.ctx, {
            artifactId: notes.id,
            summary: "Everything we ship to Zanzibar",
            author: WRITER,
        });
        expect(await search("zanzibar")).toEqual([
            ["Release notes", "content", "Everything we ship to Zanzibar"],
        ]);
        expect(await search("monday")).toEqual([["Release notes", "content", "Moved to Monday"]]);

        await w.artifacts.delete(w.ctx, { artifactId: page.id, author: WRITER });
        expect(await search("launch")).toEqual([]);
    });

    it("indexes artifacts made before the index in a background backfill", async () => {
        const w = await world("artifact-search-backfill");
        for (let index = 0; index < 45; index += 1)
            await create(w, "markdown", `Note ${index}`, "index.md", `zeppelin ${index}\n`);
        for (const statement of [
            sql`DELETE FROM happy_agent_module_artifact_words`,
            sql`DELETE FROM happy_agent_module_artifact_search_rows`,
            sql`INSERT OR REPLACE INTO happy_agent_module_artifact_search_backfill (id, artifacts_after) VALUES (1, '')`,
        ])
            await agentDatabaseRun(w.ctx.db, statement);
        expect(await w.artifacts.search(w.ctx, "zeppelin", 100)).toEqual([]);

        const agents = w.agents.asRef();
        await w.durableFunctions.beforeStart(w.ctx).afterStart?.(w.ctx, agents);
        await w.hooks.afterStart?.(w.ctx, agents);
        await vi.waitFor(async () => {
            expect(await w.artifacts.search(w.ctx, "zeppelin", 100)).toHaveLength(45);
            expect(
                await agentDatabaseRows(
                    w.ctx.db,
                    sql`SELECT id FROM happy_agent_module_artifact_search_backfill`,
                ),
            ).toEqual([]);
        });
    });
});
