import type { AnyAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactRecord } from "../../sources/artifacts/index.js";
import {
    artifactsWorld,
    imageBytes,
    sha256,
    type ArtifactsWorld,
} from "./support/artifactsWorld.js";

const AGENT = "agentwriter";
const BOT = "botwriter";

const worlds: ArtifactsWorld[] = [];
afterEach(async () => {
    for (const world of worlds.splice(0)) await world.close();
});

/** A bot's agent with a machine whose workspace is `/workspace`. */
async function world(name: string): Promise<ArtifactsWorld> {
    const created = await artifactsWorld(name);
    created.agents.add(AGENT);
    created.places.botAgents.set(AGENT, BOT);
    worlds.push(created);
    return created;
}

/** Run one tool call the way the agent loop does, with an invocation store of its own. */
async function call(
    ctx: Context,
    tool: AnyAgentTool,
    args: unknown,
    options: { readonly id?: string; readonly remembered?: Map<string, unknown> } = {},
): Promise<unknown> {
    const remembered = options.remembered ?? new Map<string, unknown>();
    return await tool.execute(ctx, args, {
        id: options.id ?? "toolcall",
        kv: {
            getOrCreate: async (_ctx: Context, key: string, create: () => unknown) => {
                if (!remembered.has(key)) remembered.set(key, await create());
                return remembered.get(key);
            },
        },
    } as never);
}

function textOf(tool: AnyAgentTool, result: unknown): string {
    return tool
        .toLLM(result)
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
}

async function png(): Promise<Buffer> {
    return await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
        .png()
        .toBuffer();
}

describe("the artifact tools", () => {
    it("offers every agent the six artifact tools", async () => {
        const w = await world("artifact-tools-offer");
        expect((await w.tools(AGENT)).map((tool) => tool.name)).toEqual([
            "create_artifact",
            "update_artifact",
            "list_artifacts",
            "read_artifact",
            "read_artifact_file",
            "delete_artifact",
        ]);
    });

    it("publishes inline text beside files copied from the agent's machine", async () => {
        const w = await world("artifact-tools-create");
        const chart = await png();
        w.machine.writeBuffer("/workspace/out/chart.png", chart);
        w.machine.write("/workspace/style.css", "body { color: teal; }");
        const create = await w.tool(AGENT, "create_artifact");
        const remembered = new Map<string, unknown>();
        const args = {
            type: "html",
            title: "Launch page",
            files: [
                { content: '<link rel="stylesheet" href="style.css"><img src="img/chart.png">' },
                { path: "img/chart.png", fromPath: "out/chart.png" },
                { fromPath: "/workspace/style.css" },
            ],
        };

        const artifact = (await call(w.ctx, create, args, { remembered })) as ArtifactRecord;

        expect(artifact).toMatchObject({
            type: "html",
            title: "Launch page",
            fileCount: 3,
            entry: { path: "index.html", mimeType: "text/html" },
            createdBy: { kind: "agent", agentId: AGENT, botId: BOT },
            source: { kind: "bot", botId: BOT, agentId: AGENT },
        });
        const version = await w.artifacts.getVersion(w.ctx, artifact.id, 1);
        expect(version.files.map((file) => [file.path, file.mimeType, file.sha256])).toEqual([
            ["img/chart.png", "image/png", sha256(chart)],
            ["index.html", "text/html", version.entry.sha256],
            ["style.css", "text/css", sha256("body { color: teal; }")],
        ]);
        expect(textOf(create, artifact)).toContain('opening "index.html"');

        // A call repeated after an interruption returns what it made, staging nothing again.
        const uploadsBefore = await w.uploadRows();
        await expect(call(w.ctx, create, args, { remembered })).resolves.toEqual(artifact);
        expect(await w.uploadRows()).toBe(uploadsBefore);
        expect((await w.artifacts.list(w.ctx)).artifacts).toHaveLength(1);
    });

    it("refuses files described both ways, unnamed text for a file type, and missing files", async () => {
        const w = await world("artifact-tools-refusals");
        const create = await w.tool(AGENT, "create_artifact");

        await expect(
            call(w.ctx, create, {
                type: "markdown",
                title: "Both",
                files: [{ content: "# Hi", fromPath: "notes.md" }],
            }),
        ).rejects.toThrow("Give each file either its content as text or fromPath");
        await expect(
            call(w.ctx, create, {
                type: "image",
                title: "Text image",
                files: [{ content: "<svg/>" }],
            }),
        ).rejects.toThrow("Name the path of every text file");
        await expect(
            call(w.ctx, create, {
                type: "image",
                title: "Missing",
                files: [{ fromPath: "out/missing.png" }],
            }),
        ).rejects.toThrow();
        expect((await w.artifacts.list(w.ctx)).artifacts).toEqual([]);
    });

    it("places a generated image into an existing artifact, keeping what did not change", async () => {
        const w = await world("artifact-tools-update");
        const create = await w.tool(AGENT, "create_artifact");
        const artifact = (await call(w.ctx, create, {
            type: "markdown",
            title: "Report",
            files: [
                { content: "# Report\n\n![Old](images/old.png)" },
                { path: "images/old.png", content: "not really a picture" },
                { path: "appendix.md", content: "Appendix" },
            ],
        })) as ArtifactRecord;
        const generated = await png();
        w.machine.writeBuffer("/workspace/generated/chart.png", generated);
        const update = await w.tool(AGENT, "update_artifact");
        const args = {
            artifactId: artifact.id,
            files: [
                { path: "images/chart.png", fromPath: "generated/chart.png" },
                { content: "# Report\n\n![Chart](images/chart.png)" },
            ],
            remove: ["images/old.png"],
        };

        const updated = (await call(w.ctx, update, args, { id: "updatecall" })) as ArtifactRecord;

        expect(updated).toMatchObject({ latestVersion: 2, fileCount: 3 });
        const version = await w.artifacts.getVersion(w.ctx, artifact.id, 2);
        expect(version.files.map((file) => file.path)).toEqual([
            "appendix.md",
            "images/chart.png",
            "index.md",
        ]);
        expect(version.files[1]?.sha256).toBe(sha256(generated));
        expect(textOf(update, updated)).toContain("version 2");
        // The call's own ID keys the version, so repeating it makes no other.
        await expect(call(w.ctx, update, args, { id: "updatecall" })).resolves.toEqual(updated);
        expect((await w.artifacts.get(w.ctx, artifact.id))?.latestVersion).toBe(2);
    });

    it("reads an artifact's manifest and entry, then single files as text, image, or description", async () => {
        const w = await world("artifact-tools-read");
        const chart = await png();
        w.machine.writeBuffer("/workspace/chart.png", chart);
        w.machine.writeBuffer("/workspace/spec.pdf", new TextEncoder().encode("%PDF-1.7"));
        w.machine.writeBuffer("/workspace/blob.bin", imageBytes("blob"));
        const create = await w.tool(AGENT, "create_artifact");
        const artifact = (await call(w.ctx, create, {
            type: "markdown",
            title: "Readable",
            files: [
                { content: "# Readable\n\n![Chart](images/chart.png)" },
                { path: "images/chart.png", fromPath: "chart.png" },
                { path: "data/table.csv", content: `id,name\n${"1,ünïcödé\n".repeat(10_000)}` },
                { path: "files/spec.pdf", fromPath: "spec.pdf" },
                { path: "files/raw", fromPath: "blob.bin" },
                { path: "files/notes", content: "plain words" },
            ],
        })) as ArtifactRecord;

        const read = await w.tool(AGENT, "read_artifact");
        const overview = textOf(read, await call(w.ctx, read, { artifactId: artifact.id }));
        expect(overview).toContain('6 files, opening "index.md"');
        expect(overview).toContain('- "images/chart.png" · image/png');
        expect(overview).toContain("![Chart](images/chart.png)");

        const readFile = await w.tool(AGENT, "read_artifact_file");
        const first = (await call(w.ctx, readFile, {
            artifactId: artifact.id,
            path: "data/table.csv",
        })) as { text: string; nextOffset: number };
        expect(first.text.startsWith("id,name\n1,ünïcödé")).toBe(true);
        expect(first.nextOffset).toBeLessThanOrEqual(64 * 1024);
        // Windows end on whole characters, so reading on never shows a broken one.
        const second = (await call(w.ctx, readFile, {
            artifactId: artifact.id,
            path: "data/table.csv",
            offset: first.nextOffset,
        })) as { text: string };
        expect(`${first.text}${second.text}`).not.toContain("\uFFFD");
        expect(textOf(readFile, first)).toContain(
            `read on with offset ${String(first.nextOffset)}`,
        );

        const image = await call(w.ctx, readFile, {
            artifactId: artifact.id,
            path: "images/chart.png",
        });
        expect(readFile.toLLM(image).map((block) => block.type)).toEqual(["text", "image"]);

        for (const path of ["files/spec.pdf", "files/raw"]) {
            const described = await call(w.ctx, readFile, { artifactId: artifact.id, path });
            expect(textOf(readFile, described)).toContain("its bytes are not shown");
        }
        // A file of no known type is still shown when its bytes are text.
        const notes = await call(w.ctx, readFile, { artifactId: artifact.id, path: "files/notes" });
        expect(textOf(readFile, notes)).toContain("plain words");
        await expect(
            call(w.ctx, readFile, { artifactId: artifact.id, path: "images/missing.png" }),
        ).rejects.toThrow('The version has no file at "images/missing.png".');
    });

    it("lists everything or only what was made where the agent works", async () => {
        const w = await world("artifact-tools-list");
        w.agents.add("agentelsewhere");
        const create = await w.tool(AGENT, "create_artifact");
        const mine = (await call(w.ctx, create, {
            type: "markdown",
            title: "Mine",
            files: [{ content: "# Mine" }],
        })) as ArtifactRecord;
        const theirs = (await call(w.ctx, await w.tool("agentelsewhere", "create_artifact"), {
            type: "markdown",
            title: "Theirs",
            files: [{ content: "# Theirs" }],
        })) as ArtifactRecord;
        expect(theirs.source).toEqual({ kind: "agent", agentId: "agentelsewhere" });

        const list = await w.tool(AGENT, "list_artifacts");
        const all = (await call(w.ctx, list, {})) as { artifacts: ArtifactRecord[] };
        expect(all.artifacts.map((artifact) => artifact.id).sort()).toEqual(
            [mine.id, theirs.id].sort(),
        );
        const here = await call(w.ctx, list, { scope: "here" });
        expect((here as { artifacts: ArtifactRecord[] }).artifacts.map((a) => a.id)).toEqual([
            mine.id,
        ]);
        expect(textOf(list, here)).toContain(`Artifacts made in bot ${BOT}:`);
    });

    it("always has Auto review a deletion, and reviews and elevates only reads leaving the workspace", async () => {
        const w = await world("artifact-tools-permissions");
        const create = await w.tool(AGENT, "create_artifact");
        const update = await w.tool(AGENT, "update_artifact");
        const remove = await w.tool(AGENT, "delete_artifact");
        w.machine.writeBuffer("/workspace/inside.png", imageBytes("inside"));
        const inline = { type: "markdown", title: "Inline", files: [{ content: "# Hi" }] };
        const inside = { type: "image", title: "In", files: [{ fromPath: "inside.png" }] };
        const outside = { type: "image", title: "Out", files: [{ fromPath: "/etc/photo.png" }] };

        for (const tool of [create]) {
            for (const [args, crosses] of [
                [inline, false],
                [inside, false],
                [outside, true],
            ] as const) {
                expect(await tool.shouldReviewInAutoMode(args, w.ctx)).toBe(crosses);
                expect(await tool.shouldRunInFullAccessInAutoMode?.(args, w.ctx)).toBe(crosses);
            }
        }
        expect(
            await update.shouldReviewInAutoMode(
                { artifactId: "artifactone", files: [{ fromPath: "~/secret.png" }] },
                w.ctx,
            ),
        ).toBe(true);
        expect(create.describeAutoPermissionAction?.(outside, w.ctx)).toContain(
            '"/etc/photo.png" from this machine',
        );

        const artifact = (await call(w.ctx, create, inline)) as ArtifactRecord;
        expect(await remove.shouldReviewInAutoMode({ artifactId: artifact.id }, w.ctx)).toBe(true);
        expect(remove.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(remove.transactional).toBe(true);
        expect(remove.describeAutoPermissionAction?.({ artifactId: artifact.id }, w.ctx)).toContain(
            "cannot be restored",
        );
        const deleted = (await call(w.ctx, remove, { artifactId: artifact.id })) as ArtifactRecord;
        expect(deleted).toMatchObject({
            status: "deleted",
            deletedBy: { kind: "agent", agentId: AGENT, botId: BOT },
            deletedSource: { kind: "bot", botId: BOT, agentId: AGENT },
        });
        await expect(
            call(w.ctx, update, { artifactId: artifact.id, title: "Back" }),
        ).rejects.toThrow("The artifact was deleted, so it cannot change.");
        const read = await w.tool(AGENT, "read_artifact");
        expect(textOf(read, await call(w.ctx, read, { artifactId: artifact.id }))).toContain(
            "no longer available",
        );
    });
});
