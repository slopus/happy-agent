import type { AnyAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import type { ArtifactRecord } from "../../sources/artifacts/index.js";
import { validateGenUiRenderDocument } from "../../sources/impl/genUi/validateGenUiDocument.js";
import { artifactsWorld, imageBytes, type ArtifactsWorld } from "./support/artifactsWorld.js";

const AGENT = "agentwriter";

const worlds: ArtifactsWorld[] = [];
afterEach(async () => {
    for (const world of worlds.splice(0)) await world.close();
});

async function world(name: string): Promise<ArtifactsWorld> {
    const created = await artifactsWorld(name);
    created.agents.add(AGENT);
    created.places.botAgents.set(AGENT, "botwriter");
    worlds.push(created);
    return created;
}

let calls = 0;

/** Run one tool call the way the agent loop does, with an invocation store of its own. */
async function call(w: ArtifactsWorld, name: string, args: unknown): Promise<unknown> {
    calls += 1;
    const remembered = new Map<string, unknown>();
    const tool: AnyAgentTool = await w.tool(AGENT, name);
    return await tool.execute(w.ctx, args, {
        id: `call${String(calls)}`,
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

/** A real picture of the given size, so the daemon measures it. */
async function png(width: number, height: number): Promise<Buffer> {
    return await sharp({
        create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } },
    })
        .png()
        .toBuffer();
}

function gallery(fallback: string, sources = ["assets/coast.png", "assets/lake.png"]) {
    return JSON.stringify({
        genui: 1,
        fallback,
        root: {
            type: "stack",
            children: [
                { type: "text", id: "intro", text: "Two stays that fit your **dates**:" },
                {
                    type: "gallery",
                    id: "photos",
                    layout: "grid",
                    items: sources.map((src, index) => ({
                        image: { src, alt: `Stay ${String(index + 1)}` },
                    })),
                },
            ],
        },
    });
}

function stat(fallback: string, value: unknown = "$1.24M") {
    return JSON.stringify({
        genui: 1,
        fallback,
        root: { type: "stat", id: "revenue", label: "Revenue", value },
    });
}

/** Create a gallery with its two pictures copied in from the agent's machine. */
async function createGallery(w: ArtifactsWorld, fallback: string): Promise<ArtifactRecord> {
    w.machine.writeBuffer("/workspace/coast.png", await png(30, 20));
    w.machine.writeBuffer("/workspace/lake.png", await png(20, 20));
    return (await call(w, "create_artifact", {
        type: "gen_ui",
        title: "Stays",
        content: gallery(fallback),
        files: [
            { fromPath: "coast.png", path: "assets/coast.png" },
            { fromPath: "lake.png", path: "assets/lake.png" },
        ],
    })) as ArtifactRecord;
}

/** The render document of an artifact's latest version, as a client reads it. */
async function renderOf(w: ArtifactsWorld, artifactId: string): Promise<Record<string, unknown>> {
    const read = await w.artifacts.readFile(w.ctx, artifactId, "latest", ".genui/render.json", {
        maxBytes: 1024 * 1024,
    });
    return JSON.parse(new TextDecoder().decode(read.bytes)) as Record<string, unknown>;
}

describe("gen_ui artifacts", () => {
    it("validates, measures its pictures, compiles, and stores both documents in one version", async () => {
        const w = await world("artifact-genui-create");
        const fallback = "A cliffside cabin and a lake view, both free that weekend.";
        const artifact = await createGallery(w, fallback);
        expect(artifact).toMatchObject({
            type: "gen_ui",
            latestVersion: 1,
            fileCount: 4,
            entry: { path: "index.genui.json", mimeType: "application/json" },
            summary: fallback,
        });
        const version = await w.artifacts.getVersion(w.ctx, artifact.id, 1);
        expect(version.files.map((file) => file.path)).toEqual([
            ".genui/render.json",
            "assets/coast.png",
            "assets/lake.png",
            "index.genui.json",
        ]);
        const coast = version.files.find((file) => file.path === "assets/coast.png")!;
        expect(coast).toMatchObject({ width: 30, height: 20 });

        const render = await renderOf(w, artifact.id);
        expect(validateGenUiRenderDocument(render)).toEqual([]);
        expect(render).toMatchObject({
            genuiRender: 1,
            compiler: "1.0.0",
            fallback,
            root: "stack",
        });
        const elements = render.elements as Record<string, { props: Record<string, unknown> }>;
        expect(elements["intro"]!.props.spans).toEqual([
            { text: "Two stays that fit your " },
            { text: "dates", strong: true },
            { text: ":" },
        ]);
        expect(elements["photos.0"]!.props).toEqual({
            file: "assets/coast.png",
            width: 30,
            height: 20,
            thumbhash: coast.thumbhash,
            alt: "Stay 1",
            shape: "landscape",
            role: "tile",
            viewer: { group: "photos", index: 0 },
        });

        expect(
            (await w.artifacts.search(w.ctx, "cliffside", 10)).map((hit) => [
                hit.title,
                hit.snippet,
            ]),
        ).toEqual([["Stays", fallback]]);
    });

    it("keeps the render document and what it derives from away from the model", async () => {
        const w = await world("artifact-genui-hidden");
        const artifact = await createGallery(w, "Two stays.");
        const created = await w.tool(AGENT, "read_artifact");
        const read = await call(w, "read_artifact", { artifactId: artifact.id });
        const text = textOf(created, read);
        expect(text).toContain("3 files");
        expect(text).toContain('"assets/coast.png"');
        expect(text).not.toContain(".genui/");
        expect(JSON.stringify(read)).not.toContain(".genui/render.json");
        await expect(
            call(w, "read_artifact_file", { artifactId: artifact.id, path: ".genui/render.json" }),
        ).rejects.toThrow('The version has no file at ".genui/render.json".');
        await expect(
            call(w, "write_artifact_file", {
                artifactId: artifact.id,
                path: ".genui/render.json",
                content: "{}",
            }),
        ).rejects.toThrow(/derived from the Gen UI document/);
        await expect(
            call(w, "update_artifact", { artifactId: artifact.id, remove: [".genui/render.json"] }),
        ).rejects.toThrow(/derived from the Gen UI document/);
        expect((await w.artifacts.get(w.ctx, artifact.id))?.latestVersion).toBe(1);
    });

    it("refuses an invalid document with the validator's reasons and makes nothing", async () => {
        const w = await world("artifact-genui-invalid");
        const invalid = JSON.stringify({
            genui: 1,
            root: {
                type: "card",
                badge: { text: "Live", tone: "magenta" },
                children: [{ type: "stat", label: "Revenue", value: 1240000 }],
            },
        });
        const failure = call(w, "create_artifact", {
            type: "gen_ui",
            title: "Q3",
            content: invalid,
        });
        await expect(failure).rejects.toThrow(/not a valid Gen UI document/);
        await expect(failure).rejects.toThrow(
            /root<card>\.badge\.tone: "magenta" is not one of[\s\S]*root<card>\.children\[0\]<stat>\.value: expected string/,
        );
        await expect(
            call(w, "create_artifact", { type: "gen_ui", title: "Empty" }),
        ).rejects.toThrow("A gen_ui artifact needs its document: pass it as content.");
        expect((await w.artifacts.list(w.ctx)).artifacts).toEqual([]);
        expect(w.events).toEqual([]);
    });

    it("refuses images it cannot store and measure, naming each element", async () => {
        const w = await world("artifact-genui-images");
        w.machine.writeBuffer("/workspace/broken.png", imageBytes("broken"));
        const failure = call(w, "create_artifact", {
            type: "gen_ui",
            title: "Stays",
            content: gallery("Stays.", [
                "https://example.com/coast.jpg",
                "assets/missing.png",
                "assets/broken.png",
            ]),
            files: [{ fromPath: "broken.png", path: "assets/broken.png" }],
        });
        await expect(failure).rejects.toThrow(
            /root<stack>\.children\[1\]<gallery>\.items\[0\]\.image\.src: "https:\/\/example\.com\/coast\.jpg" is a remote image/,
        );
        await expect(failure).rejects.toThrow(
            /root<stack>\.children\[1\]<gallery>\.items\[1\]\.image\.src: the artifact has no file "assets\/missing\.png"/,
        );
        await expect(failure).rejects.toThrow(
            /root<stack>\.children\[1\]<gallery>\.items\[2\]\.image\.src: "assets\/broken\.png" is not a PNG/,
        );
        expect((await w.artifacts.list(w.ctx)).artifacts).toEqual([]);
    });

    it("compiles every later version and keeps the summary on the fallback until someone writes one", async () => {
        const w = await world("artifact-genui-update");
        const created = (await call(w, "create_artifact", {
            type: "gen_ui",
            title: "Q3",
            content: stat("Revenue was $1.24M."),
        })) as ArtifactRecord;
        await expect(
            call(w, "write_artifact_file", {
                artifactId: created.id,
                path: "index.genui.json",
                content: stat("Revenue.", 1240000),
            }),
        ).rejects.toThrow(/root<stat>\.value: expected string/);
        await expect(
            call(w, "edit_artifact_file", {
                artifactId: created.id,
                path: "index.genui.json",
                old_string: '"$1.24M"',
                new_string: "42",
            }),
        ).rejects.toThrow(/root<stat>\.value: expected string/);
        expect((await w.artifacts.get(w.ctx, created.id))?.latestVersion).toBe(1);

        await call(w, "edit_artifact_file", {
            artifactId: created.id,
            path: "index.genui.json",
            old_string: '"$1.24M"',
            new_string: '"$1.31M"',
        });
        expect(await renderOf(w, created.id)).toMatchObject({
            elements: { "revenue.value": { props: { spans: [{ text: "$1.31M" }] } } },
        });
        await call(w, "write_artifact_file", {
            artifactId: created.id,
            path: "index.genui.json",
            content: stat("Revenue was $1.4M."),
        });
        expect(await w.artifacts.get(w.ctx, created.id)).toMatchObject({
            latestVersion: 3,
            summary: "Revenue was $1.4M.",
        });
        await call(w, "update_artifact", { artifactId: created.id, summary: "Picked for June." });
        await call(w, "write_artifact_file", {
            artifactId: created.id,
            path: "index.genui.json",
            content: stat("Revenue was $1.5M."),
        });
        expect(await w.artifacts.get(w.ctx, created.id)).toMatchObject({
            latestVersion: 5,
            summary: "Picked for June.",
        });
        expect(await renderOf(w, created.id)).toMatchObject({ fallback: "Revenue was $1.5M." });
    });
});
