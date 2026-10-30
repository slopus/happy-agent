import { withAgentPermissionMode, type AnyAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { Value } from "@sinclair/typebox/value";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
    MAX_AGENT_ARTIFACT_VERSIONS_PER_HOUR,
    type ArtifactRecord,
} from "../../sources/artifacts/index.js";
import {
    artifactsWorld,
    imageBytes,
    sha256,
    type ArtifactsWorld,
} from "./support/artifactsWorld.js";

const AGENT = "agentwriter";
const BOT = "botwriter";
const OTHER = "agentelsewhere";

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

type WrittenFile = ArtifactRecord & {
    readonly path: string;
    readonly changed: boolean;
    readonly replacements?: number;
};

/** Create an artifact with the agent's own tool, the way the model does. */
async function create(
    w: ArtifactsWorld,
    args: Record<string, unknown>,
    agentId = AGENT,
): Promise<ArtifactRecord> {
    return (await call(w.ctx, await w.tool(agentId, "create_artifact"), args)) as ArtifactRecord;
}

let calls = 0;

/** Write one whole file with the agent's own tool, as one call. */
async function write(
    w: ArtifactsWorld,
    artifactId: string,
    path: string,
    content: string,
    options: { readonly id?: string; readonly agentId?: string } = {},
): Promise<WrittenFile> {
    calls += 1;
    return (await call(
        w.ctx,
        await w.tool(options.agentId ?? AGENT, "write_artifact_file"),
        { artifactId, path, content },
        { id: options.id ?? `write${String(calls)}` },
    )) as WrittenFile;
}

/** The text of one file in an artifact's latest version. */
async function textAt(w: ArtifactsWorld, artifactId: string, path: string): Promise<string> {
    return (await w.artifacts.readText(w.ctx, artifactId, path)).text;
}

describe("the artifact tools", () => {
    it("offers every agent the artifact tools", async () => {
        const w = await world("artifact-tools-offer");
        expect((await w.tools(AGENT)).map((tool) => tool.name)).toEqual([
            "create_artifact",
            "write_artifact_file",
            "edit_artifact_file",
            "update_artifact",
            "list_artifacts",
            "read_artifact",
            "read_artifact_file",
            "delete_artifact",
        ]);
    });

    it("creates live artifacts with inert files, fixed networks, review, and idempotent calls", async () => {
        const w = await world("live-artifact-create");
        const tool = await w.tool(AGENT, "create_artifact");
        const args = {
            type: "html",
            title: "Live <script>alert(1)</script>",
            url: "http://localhost:5173",
            display: "inline_expanded",
        };
        const ctx = withAgentPermissionMode(w.ctx, "auto");
        const remembered = new Map<string, unknown>();
        expect(await tool.shouldReviewInAutoMode(args, ctx)).toBe(true);
        expect(await tool.shouldRunInFullAccessInAutoMode?.(args, ctx)).toBe(false);
        expect(tool.describeAutoPermissionAction?.(args, ctx)).toContain('network "host"');
        expect(tool.describeAutoPermissionAction?.(args, ctx)).toContain(
            "exposes localhost:5173 on the agent's machine to the page",
        );
        const artifact = (await call(ctx, tool, args, { remembered })) as ArtifactRecord;
        expect(artifact).toMatchObject({
            live: { url: "http://localhost:5173/", networkId: "host" },
            fileCount: 1,
            latestVersion: 1,
            latestMajor: 1,
            latestMinor: 0,
        });
        expect(Value.Check(tool.returnType, artifact)).toBe(true);
        const text = await textAt(w, artifact.id, "index.html");
        expect(text).not.toContain("alert(1)");
        expect(text).toContain("This is a live page.");
        expect(text).toContain("newer Happy");
        expect(text).not.toMatch(/<script|<iframe|http:\/\/localhost|http-equiv|href=/i);
        expect(textOf(tool, artifact)).toContain("Change its URL with update_artifact");
        w.networkId.mockResolvedValue("r-other");
        expect(await call(ctx, tool, args, { remembered })).toEqual(artifact);
        expect(w.events).toHaveLength(1);

        const nextArgs = { ...args };
        await tool.shouldReviewInAutoMode(nextArgs, ctx);
        w.networkId.mockResolvedValue("r-moved");
        await expect(call(ctx, tool, nextArgs)).rejects.toThrow("network changed");
        expect((await w.artifacts.list(w.ctx)).artifacts).toHaveLength(1);
        await expect(call(withAgentPermissionMode(w.ctx, "read_only"), tool, args)).rejects.toThrow(
            "Read only",
        );
    });

    it("reviews every live update and rejects file changes and stale reviewed versions", async () => {
        const w = await world("live-artifact-update");
        const artifact = (await call(
            withAgentPermissionMode(w.ctx, "full_access"),
            await w.tool(AGENT, "create_artifact"),
            { type: "html", title: "Preview", url: "http://localhost:5173/" },
        )) as ArtifactRecord;
        const tool = await w.tool(AGENT, "update_artifact");
        const ctx = withAgentPermissionMode(w.ctx, "auto");
        const args = { artifactId: artifact.id, url: "HTTPS://EXAMPLE.COM/new" };
        await expect(tool.shouldReviewInAutoMode(args, ctx)).resolves.toBe(true);
        expect(await tool.shouldRunInFullAccessInAutoMode?.(args, ctx)).toBe(false);
        expect(tool.describeAutoPermissionAction?.(args, ctx)).toContain('recorded network "host"');
        expect(tool.describeAutoPermissionAction?.(args, ctx)).toContain(
            "permits only public destinations",
        );
        expect(tool.describeAutoPermissionAction?.(args, ctx)).toContain(
            'to "https://example.com/new"',
        );
        w.networkId.mockRejectedValue(new Error("The creator moved."));
        const updated = (await call(ctx, tool, args, { id: "live-update" })) as ArtifactRecord;
        expect(updated).toMatchObject({
            latestVersion: 2,
            latestMinor: 1,
            live: { url: "https://example.com/new", networkId: "host" },
        });
        expect((await w.artifacts.getVersion(w.ctx, artifact.id, 1)).live?.url).toBe(
            "http://localhost:5173/",
        );
        expect(await call(ctx, tool, args, { id: "live-update" })).toEqual(updated);
        const rename = { artifactId: artifact.id, title: "Retitled <page>" };
        expect(await tool.shouldReviewInAutoMode(rename, ctx)).toBe(true);
        const retitled = (await call(ctx, tool, rename, { id: "live-rename" })) as ArtifactRecord;
        expect(retitled.live).toEqual(updated.live);
        expect(retitled.entry).toEqual(artifact.entry);
        expect(await textAt(w, artifact.id, "index.html")).not.toContain("Retitled");
        await expect(call(ctx, tool, args, { id: "stale-review" })).rejects.toThrow(
            "changed or was not reviewed",
        );
        const count = w.events.length;
        await expect(write(w, artifact.id, "index.html", "replacement")).rejects.toThrow(
            "live URL",
        );
        await expect(
            call(w.ctx, await w.tool(AGENT, "edit_artifact_file"), {
                artifactId: artifact.id,
                path: "index.html",
                old_string: "missing",
                new_string: "changed",
            }),
        ).rejects.toThrow("live URL");
        for (const changes of [{ files: [] }, { remove: [] }, { replaceAll: false }]) {
            await expect(
                w.artifacts.update(w.ctx, {
                    artifactId: artifact.id,
                    author: { kind: "user" },
                    ...changes,
                }),
            ).rejects.toThrow("live URL");
        }
        expect(w.events).toHaveLength(count);
        expect((await w.artifacts.get(w.ctx, artifact.id))?.latestVersion).toBe(3);
        const privateUrl = { artifactId: artifact.id, url: "http://169.254.169.254/" };
        expect(await tool.shouldReviewInAutoMode(privateUrl, ctx)).toBe(true);
        expect(tool.describeAutoPermissionAction?.(privateUrl, ctx)).toContain(
            "non-public address; the artifact proxy will refuse it",
        );
    });

    it("composes live version changes with caller transactions and keeps the original network across authors", async () => {
        const w = await world("live-artifact-transactions");
        const artifact = (await call(
            withAgentPermissionMode(w.ctx, "full_access"),
            await w.tool(AGENT, "create_artifact"),
            {
                type: "html",
                title: "Preview",
                url: "http://localhost:5173/",
            },
        )) as ArtifactRecord;
        const input = {
            artifactId: artifact.id,
            author: { kind: "agent" as const, agentId: OTHER },
        };
        const noChange = await w.artifacts.update(w.ctx, {
            ...input,
            url: "http://localhost:5173",
        });
        expect(noChange.latestVersion).toBe(1);
        await expect(w.artifacts.update(w.ctx, { ...input, major: 2 })).rejects.toThrow(
            "already a major version",
        );
        await expect(
            w.ctx.inTx(async (ctx) => {
                await w.artifacts.update(ctx, { ...input, title: "Rolled-back title" });
                expect((await w.artifacts.get(ctx, artifact.id))?.title).toBe("Rolled-back title");
                expect(w.events).toHaveLength(1);
                throw new Error("Rollback the caller");
            }),
        ).rejects.toThrow("Rollback the caller");
        expect(await w.artifacts.get(w.ctx, artifact.id)).toEqual(noChange);
        expect(w.events).toHaveLength(1);
        await w.ctx.inTx(async (ctx) => {
            await w.artifacts.update(ctx, { ...input, url: "https://example.com/committed" });
            expect(w.events).toHaveLength(1);
        });
        expect(w.events).toHaveLength(2);
        const major = await w.artifacts.update(w.ctx, { ...input, major: 2 });
        expect(major).toMatchObject({
            latestVersion: 3,
            latestMajor: 2,
            latestMinor: 0,
            live: { url: "https://example.com/committed", networkId: "host" },
            updatedBy: input.author,
        });
        expect((await w.artifacts.getVersion(w.ctx, artifact.id, 1)).live).toEqual(artifact.live);
    });

    it("reviews live artifact creation and rejects unsafe URLs", async () => {
        const w = await world("live-page-create");
        const tool = await w.tool(AGENT, "create_artifact");
        const ctx = withAgentPermissionMode(w.ctx, "auto");
        const args = {
            type: "html",
            title: "Checkout\u202e",
            url: "http://localhost:5173/",
            display: "side",
        };
        expect(await tool.shouldReviewInAutoMode(args, ctx)).toBe(true);
        expect(tool.describeAutoPermissionAction?.(args, ctx)).toContain(
            'titled "Checkout\\u{202e}"',
        );
        expect(await tool.shouldRunInFullAccessInAutoMode?.(args, ctx)).toBe(false);
        const result = (await call(ctx, tool, args)) as ArtifactRecord;
        expect(result).toMatchObject({
            type: "html",
            display: "side",
            live: { networkId: "host", url: args.url },
            presentation: { type: "artifact", shows: "latest", artifactId: result.id },
        });
        for (const url of [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "not a url",
            "https://me:pw@example.com/",
        ]) {
            await expect(
                call(w.ctx, tool, { type: "html", title: "Invalid", url }),
            ).rejects.toThrow();
        }
        const createTool = await w.tool(AGENT, "create_artifact");
        for (const invalid of [
            { type: "markdown", url: args.url },
            { type: "html", url: args.url, files: [] },
        ]) {
            await expect(call(w.ctx, createTool, { title: "Invalid", ...invalid })).rejects.toThrow(
                "requires type html",
            );
        }
        expect((await w.artifacts.list(w.ctx)).artifacts).toHaveLength(1);
    });

    it("tells every agent to mention artifacts by their Happy links", async () => {
        const w = await world("artifact-tools-references");
        const instructions = await w.instructions(AGENT);
        expect(instructions).toContain("[its title](happy://artifacts/<artifactId>)");
        expect(instructions).toContain("?version=N");
    });

    it("creates an artifact with an entry to start from and the files copied in", async () => {
        const w = await world("artifact-tools-create");
        const chart = await png();
        w.machine.writeBuffer("/workspace/out/chart.png", chart);
        const tool = await w.tool(AGENT, "create_artifact");
        const remembered = new Map<string, unknown>();
        const args = {
            type: "html",
            title: "Launch <page>",
            display: "inline_expanded",
            files: [{ path: "img/chart.png", fromPath: "out/chart.png" }],
        };
        const filesBefore = [...w.machine.files.keys()];

        const artifact = (await call(w.ctx, tool, args, { remembered })) as ArtifactRecord;

        expect(artifact).toMatchObject({
            type: "html",
            title: "Launch <page>",
            display: "inline_expanded",
            latestVersion: 1,
            latestMajor: 1,
            latestMinor: 0,
            fileCount: 2,
            entry: { path: "index.html", mimeType: "text/html" },
            createdBy: { kind: "agent", agentId: AGENT, botId: BOT },
            source: { kind: "bot", botId: BOT, agentId: AGENT },
        });
        const entry = await textAt(w, artifact.id, "index.html");
        expect(entry).toContain("<title>Launch &lt;page&gt;</title>");
        const version = await w.artifacts.getVersion(w.ctx, artifact.id, 1);
        expect(version).toMatchObject({ major: 1, minor: 0, display: "inline_expanded" });
        expect(version.files.map((file) => [file.path, file.sha256])).toEqual([
            ["img/chart.png", sha256(chart)],
            ["index.html", sha256(entry)],
        ]);
        // The catalog holds the only copy: nothing is written on the agent's machine.
        expect([...w.machine.files.keys()]).toEqual(filesBefore);
        // The chat shows the artifact as it goes on to change.
        expect(artifact).toMatchObject({
            presentation: {
                type: "artifact",
                artifactId: artifact.id,
                version: 1,
                artifactType: "html",
                title: "Launch <page>",
                shows: "latest",
            },
        });
        const text = textOf(tool, artifact);
        expect(text).toContain("version 1 (1.0)");
        expect(text).toContain("write_artifact_file and edit_artifact_file");
        expect(text).toContain("shown inline_expanded");
        expect(text).toContain(
            "The user now sees it in this chat — an html artifact where its display preference puts it",
        );
        expect(text).toContain(
            `Mention it in chat as [Launch \\<page\\>](happy://artifacts/${artifact.id}).`,
        );

        // A call repeated after an interruption returns what it made, staging nothing again.
        const uploadsBefore = await w.uploadRows();
        await expect(call(w.ctx, tool, args, { remembered })).resolves.toEqual(artifact);
        expect(await w.uploadRows()).toBe(uploadsBefore);
        expect((await w.artifacts.list(w.ctx)).artifacts).toHaveLength(1);
    });

    it("makes one minor version for each call that writes, and none for a write that changes nothing", async () => {
        const w = await world("artifact-tools-write");
        const artifact = await create(w, { type: "html", title: "Page" });
        const tool = await w.tool(AGENT, "write_artifact_file");

        const styled = await write(w, artifact.id, "site.css", "body { color: red; }\n");
        expect(styled).toMatchObject({
            path: "site.css",
            changed: true,
            latestVersion: 2,
            latestMajor: 1,
            latestMinor: 1,
            fileCount: 2,
        });
        expect(textOf(tool, styled)).toContain(`artifact ${artifact.id} is now at version 2 (1.1)`);
        const page = '<link rel="stylesheet" href="site.css"><p>Hello</p>\n';
        const replaced = await write(w, artifact.id, "index.html", page);
        expect(replaced).toMatchObject({ latestVersion: 3, latestMinor: 2, fileCount: 2 });
        expect(await textAt(w, artifact.id, "index.html")).toBe(page);
        expect(await textAt(w, artifact.id, "site.css")).toBe("body { color: red; }\n");

        const same = await write(w, artifact.id, "index.html", page);
        expect(same).toMatchObject({ changed: false, latestVersion: 3 });
        expect(textOf(tool, same)).toContain("already held exactly this content");

        const versions = await w.artifacts.listVersions(w.ctx, artifact.id);
        expect(
            versions.versions.map((version) => [version.number, version.major, version.minor]),
        ).toEqual([
            [3, 1, 2],
            [2, 1, 1],
            [1, 1, 0],
        ]);
        expect(versions.versions[0]?.createdBy).toEqual({
            kind: "agent",
            agentId: AGENT,
            botId: BOT,
        });
    });

    it("keys each write's version by its call, so a repeat after a restart makes nothing twice", async () => {
        const w = await world("artifact-tools-replay");
        const artifact = await create(w, { type: "markdown", title: "Notes" });
        const edit = await w.tool(AGENT, "edit_artifact_file");

        const first = await write(w, artifact.id, "index.md", "# Notes\n\nOne\n", { id: "w1" });
        const again = await write(w, artifact.id, "index.md", "# Notes\n\nOne\n", { id: "w1" });
        expect(again.latestVersion).toBe(first.latestVersion);

        const args = {
            artifactId: artifact.id,
            path: "index.md",
            old_string: "One",
            new_string: "Two",
        };
        const edited = (await call(w.ctx, edit, args, { id: "e1" })) as WrittenFile;
        expect(edited.latestVersion).toBe(3);
        // The text it replaced is gone now, yet the repeat finds the version the call made.
        const repeated = (await call(w.ctx, edit, args, { id: "e1" })) as WrittenFile;
        expect(repeated.latestVersion).toBe(3);
        expect(await textAt(w, artifact.id, "index.md")).toBe("# Notes\n\nTwo\n");
        expect((await w.artifacts.get(w.ctx, artifact.id))?.latestVersion).toBe(3);
    });

    it("edits the latest version's text exactly as the file tools' Edit does", async () => {
        const w = await world("artifact-tools-edit");
        const artifact = await create(w, { type: "html", title: "Edited" });
        const edit = await w.tool(AGENT, "edit_artifact_file");
        await write(w, artifact.id, "index.html", "<p>a</p>\n<p>a</p>\n<p>b $& c</p>\n");
        const run = async (args: Record<string, unknown>, id: string) =>
            (await call(
                w.ctx,
                edit,
                { artifactId: artifact.id, path: "index.html", ...args },
                { id },
            )) as WrittenFile;

        await expect(run({ old_string: "<p>a</p>", new_string: "<p>x</p>" }, "e1")).rejects.toThrow(
            'This text appears 2 times in "index.html". Add surrounding context to make it unique, or replace every occurrence.',
        );
        await expect(run({ old_string: "<p>z</p>", new_string: "<p>x</p>" }, "e2")).rejects.toThrow(
            'This text does not appear in "index.html".',
        );
        await expect(run({ old_string: "<p>b", new_string: "<p>b" }, "e3")).rejects.toThrow(
            "The replacement is identical to the text it replaces.",
        );
        await expect(run({ old_string: "", new_string: "x" }, "e4")).rejects.toThrow(
            "old_string is empty",
        );
        expect((await w.artifacts.get(w.ctx, artifact.id))?.latestVersion).toBe(2);

        const all = await run(
            { old_string: "<p>a</p>", new_string: "<p>x</p>", replace_all: true },
            "e5",
        );
        expect(all).toMatchObject({ replacements: 2, latestVersion: 3, latestMinor: 2 });
        expect(textOf(edit, all)).toContain("in 2 places");
        // Replacement text is literal, never a pattern.
        await run({ old_string: "b $& c", new_string: "$& and $1" }, "e6");
        expect(await textAt(w, artifact.id, "index.html")).toBe(
            "<p>x</p>\n<p>x</p>\n<p>$& and $1</p>\n",
        );

        // An edit applies to the latest version, whoever made it.
        await w.artifacts.update(w.ctx, {
            artifactId: artifact.id,
            files: await w.artifacts.stageFiles(w.ctx, [
                { path: "index.html", text: "<p>by a person</p>\n" },
            ]),
            author: { kind: "user" },
        });
        await expect(run({ old_string: "<p>x</p>", new_string: "<p>y</p>" }, "e7")).rejects.toThrow(
            "This text does not appear",
        );
        const onLatest = await run({ old_string: "a person", new_string: "an agent" }, "e8");
        expect(onLatest.latestVersion).toBe(6);
        expect(await textAt(w, artifact.id, "index.html")).toBe("<p>by an agent</p>\n");
    });

    it("refuses an edit to text that changed while the call ran, rather than undoing that change", async () => {
        const w = await world("artifact-tools-race");
        const artifact = await create(w, { type: "markdown", title: "Raced" });
        const read = await w.artifacts.readText(w.ctx, artifact.id, "index.md");
        await write(w, artifact.id, "index.md", "# Raced\n\nby someone else\n");
        await expect(
            w.artifacts.commitFileChanges(w.ctx, {
                agentId: AGENT,
                artifactId: artifact.id,
                expectedRevision: read.artifact.revision,
                operationId: "late",
                writes: new Map([["index.md", new TextEncoder().encode("# Raced, edited\n")]]),
                removes: [],
            }),
        ).rejects.toThrow("changed while this call ran");
        expect(await textAt(w, artifact.id, "index.md")).toBe("# Raced\n\nby someone else\n");
    });

    it("holds every written version to the type's paths, rules, and limits, making nothing otherwise", async () => {
        const w = await world("artifact-tools-limits");
        w.machine.writeBuffer("/workspace/chart.png", await png());
        const image = await create(w, {
            type: "image",
            title: "Chart",
            files: [{ fromPath: "chart.png" }],
        });
        await expect(write(w, image.id, "notes.txt", "words")).rejects.toThrow();
        expect((await w.artifacts.get(w.ctx, image.id))?.latestVersion).toBe(1);

        const page = await create(w, { type: "markdown", title: "Page" });
        await expect(write(w, page.id, "index.md", "")).rejects.toThrow("would be empty");
        await expect(write(w, page.id, "index.md/inner.md", "x")).rejects.toThrow();
        const tool = await w.tool(AGENT, "write_artifact_file");
        for (const path of ["../escape.md", "a/./b.md", "a//b.md", "a\\b.md", "x\u0001.md", ""]) {
            expect(Value.Check(tool.parameters, { artifactId: page.id, path, content: "x" })).toBe(
                false,
            );
        }
        // The entry has its own limit.
        await expect(
            write(w, page.id, "index.md", "y".repeat(4 * 1024 * 1024 + 1)),
        ).rejects.toThrow();
        expect((await w.artifacts.get(w.ctx, page.id))?.latestVersion).toBe(1);
    });

    it("caps how many versions one agent makes of one artifact in an hour", async () => {
        const w = await world("artifact-tools-budget");
        w.agents.add(OTHER);
        const artifact = await create(w, { type: "markdown", title: "Looping" });
        for (let index = 1; index < MAX_AGENT_ARTIFACT_VERSIONS_PER_HOUR; index += 1) {
            await write(w, artifact.id, "index.md", `# Looping ${String(index)}\n`);
        }
        await expect(write(w, artifact.id, "index.md", "# One too many\n")).rejects.toThrow(
            "Make your remaining changes in fewer calls",
        );
        // Another agent is not held back by this one's loop.
        await expect(
            write(w, artifact.id, "index.md", "# Someone else\n", { agentId: OTHER }),
        ).resolves.toMatchObject({ changed: true });
    });

    it("reads text as numbered lines, a stretch at a time, and images to look at", async () => {
        const w = await world("artifact-tools-read");
        w.machine.writeBuffer("/workspace/chart.png", await png());
        w.machine.writeBuffer("/workspace/spec.pdf", new TextEncoder().encode("%PDF-1.7"));
        w.machine.writeBuffer("/workspace/raw", imageBytes("blob"));
        w.machine.write("/workspace/notes", "plain words");
        const artifact = await create(w, {
            type: "markdown",
            title: "Readable",
            files: [
                { fromPath: "chart.png", path: "images/chart.png" },
                { fromPath: "spec.pdf", path: "files/spec.pdf" },
                { fromPath: "raw", path: "files/raw" },
                { fromPath: "notes", path: "files/notes" },
            ],
        });
        await write(w, artifact.id, "index.md", "# Readable\n\n![Chart](images/chart.png)\n");
        const rows = Array.from({ length: 2_500 }, (_, index) => `${String(index)},ünïcödé`);
        await write(w, artifact.id, "data/table.csv", `id,name\n${rows.join("\n")}\n`);

        const read = await w.tool(AGENT, "read_artifact");
        const overview = textOf(read, await call(w.ctx, read, { artifactId: artifact.id }));
        expect(overview).toContain('6 files, opening "index.md"');
        expect(overview).toContain(
            `Mention it in chat as [Readable](happy://artifacts/${artifact.id}).`,
        );
        expect(overview).toContain('- "images/chart.png" · image/png');
        expect(overview).toContain("![Chart](images/chart.png)");

        const readFile = await w.tool(AGENT, "read_artifact_file");
        const entry = await call(w.ctx, readFile, { artifactId: artifact.id, path: "index.md" });
        expect(entry).toMatchObject({ startLine: 1, returnedLines: 3, totalLines: 3 });
        expect(textOf(readFile, entry)).toContain(
            "1\t# Readable\n2\t\n3\t![Chart](images/chart.png)",
        );

        const first = (await call(w.ctx, readFile, {
            artifactId: artifact.id,
            path: "data/table.csv",
        })) as { text: string };
        expect(first).toMatchObject({ returnedLines: 2_000, nextOffset: 2_001, totalLines: 2_501 });
        expect(first.text.startsWith("1\tid,name\n2\t0,ünïcödé")).toBe(true);
        expect(textOf(readFile, first)).toContain("read on with offset 2001");
        const stretch = (await call(w.ctx, readFile, {
            artifactId: artifact.id,
            path: "data/table.csv",
            offset: 2_500,
            limit: 10,
        })) as { nextOffset?: number };
        expect(stretch).toMatchObject({
            returnedLines: 2,
            text: "2500\t2498,ünïcödé\n2501\t2499,ünïcödé",
        });
        expect(stretch.nextOffset).toBeUndefined();
        // An earlier version stays readable.
        const old = await call(w.ctx, readFile, {
            artifactId: artifact.id,
            path: "index.md",
            version: 1,
        });
        expect(textOf(readFile, old)).toContain("1\t# Readable");

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
        expect(textOf(readFile, notes)).toContain("1\tplain words");
        await expect(
            call(w.ctx, readFile, { artifactId: artifact.id, path: "images/missing.png" }),
        ).rejects.toThrow('The version has no file at "images/missing.png".');
        // A binary file is not text to edit.
        const edit = await w.tool(AGENT, "edit_artifact_file");
        await expect(
            call(w.ctx, edit, {
                artifactId: artifact.id,
                path: "files/raw",
                old_string: "a",
                new_string: "b",
            }),
        ).rejects.toThrow("is not UTF-8 text");
    });

    it("refuses a file type without its file, and a missing file, creating nothing", async () => {
        const w = await world("artifact-tools-refusals");
        await expect(create(w, { type: "image", title: "Empty image" })).rejects.toThrow();
        await expect(
            create(w, {
                type: "image",
                title: "Missing",
                files: [{ fromPath: "out/missing.png" }],
            }),
        ).rejects.toThrow();
        expect((await w.artifacts.list(w.ctx)).artifacts).toEqual([]);
    });

    it("publishes an image copied in from the agent's machine", async () => {
        const w = await world("artifact-tools-image");
        const chart = await png();
        w.machine.writeBuffer("/workspace/out/chart.png", chart);
        const artifact = await create(w, {
            type: "image",
            title: "Chart",
            files: [{ fromPath: "out/chart.png" }],
        });
        expect(artifact).toMatchObject({
            type: "image",
            fileCount: 1,
            entry: { path: "chart.png", mimeType: "image/png", sha256: sha256(chart) },
        });
    });

    it("changes the title, background, display, and files, and marks major versions", async () => {
        const w = await world("artifact-tools-update");
        const tool = await w.tool(AGENT, "create_artifact");
        const update = await w.tool(AGENT, "update_artifact");
        expect(JSON.stringify(tool.parameters)).toContain("Usually leave this out");
        expect(
            Value.Check(tool.parameters, { type: "html", title: "X", background: "white" }),
        ).toBe(false);
        expect(Value.Check(tool.parameters, { type: "html", title: "X", display: "wide" })).toBe(
            false,
        );
        expect(Value.Check(update.parameters, { artifactId: "artifactx", major: 1 })).toBe(false);
        expect(
            Value.Check(update.parameters, {
                artifactId: "artifactx",
                background: null,
                display: null,
            }),
        ).toBe(true);

        const artifact = await create(w, {
            type: "html",
            title: "Invoice",
            background: "#FFFFFF",
            display: "side",
        });
        expect(artifact.background).toBe("#ffffff");
        expect(textOf(tool, artifact)).toContain("on a #ffffff background");

        // 1.0 is already a major version.
        await expect(
            call(w.ctx, update, { artifactId: artifact.id, major: 2 }, { id: "early" }),
        ).rejects.toThrow("Version 1.0 is already a major version");

        const retitled = (await call(
            w.ctx,
            update,
            { artifactId: artifact.id, title: "Invoice 42", display: "inline_compact" },
            { id: "retitle" },
        )) as ArtifactRecord;
        expect(retitled).toMatchObject({
            latestVersion: 2,
            latestMajor: 1,
            latestMinor: 1,
            title: "Invoice 42",
            background: "#ffffff",
            display: "inline_compact",
            presentation: {
                type: "artifact",
                artifactId: artifact.id,
                version: 2,
                shows: "version",
            },
        });
        expect(textOf(update, retitled)).toContain(
            `Mention it in chat as [Invoice 42](happy://artifacts/${artifact.id}), or as [Invoice 42](happy://artifacts/${artifact.id}?version=2) for this version only.`,
        );
        // The call's own ID keys the version, so repeating it makes no other.
        await expect(
            call(
                w.ctx,
                update,
                { artifactId: artifact.id, title: "Invoice 42" },
                { id: "retitle" },
            ),
        ).resolves.toEqual(retitled);

        // A version written with the file tools keeps the display and background.
        await write(w, artifact.id, "index.html", "<p>Invoice 42</p>");
        expect(await w.artifacts.getVersion(w.ctx, artifact.id, "latest")).toMatchObject({
            number: 3,
            major: 1,
            minor: 2,
            title: "Invoice 42",
            background: "#ffffff",
            display: "inline_compact",
        });

        // A major version names exactly the next major, and may carry other changes.
        await expect(
            call(w.ctx, update, { artifactId: artifact.id, major: 3 }, { id: "skip" }),
        ).rejects.toThrow("The next major version is 2: it is at 1.2 now.");
        w.machine.writeBuffer("/workspace/out/chart.png", await png());
        const major = (await call(
            w.ctx,
            update,
            {
                artifactId: artifact.id,
                major: 2,
                files: [{ fromPath: "out/chart.png", path: "img/chart.png" }],
            },
            { id: "major" },
        )) as ArtifactRecord;
        expect(major).toMatchObject({
            latestVersion: 4,
            latestMajor: 2,
            latestMinor: 0,
            fileCount: 2,
        });
        expect(textOf(update, major)).toContain("version 4 (2.0)");
        await expect(
            call(w.ctx, update, { artifactId: artifact.id, major: 3 }, { id: "again" }),
        ).rejects.toThrow("Version 2.0 is already a major version");

        const cleared = (await call(
            w.ctx,
            update,
            {
                artifactId: artifact.id,
                background: null,
                display: null,
                remove: ["img/chart.png"],
            },
            { id: "clear" },
        )) as ArtifactRecord;
        expect(cleared).toMatchObject({
            latestVersion: 5,
            latestMajor: 2,
            latestMinor: 1,
            fileCount: 1,
        });
        expect(cleared.background).toBeUndefined();
        expect(cleared.display).toBeUndefined();
        expect(textOf(update, cleared)).not.toContain("background");
    });

    it("lists everything or only what was made where the agent works", async () => {
        const w = await world("artifact-tools-list");
        w.agents.add(OTHER);
        const mine = await create(w, { type: "markdown", title: "Mine" });
        const theirs = await create(w, { type: "markdown", title: "Theirs" }, OTHER);
        expect(theirs.source).toEqual({ kind: "agent", agentId: OTHER });

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
        expect(textOf(list, here)).toContain(
            "Mention an artifact in chat as [its title](happy://artifacts/<artifactId>).",
        );
        expect(textOf(list, here)).toContain("version 1 (1.0)");
    });

    it("lets an agent write its own artifacts freely and has Auto review writing anyone else's", async () => {
        const w = await world("artifact-tools-review");
        w.agents.add(OTHER);
        const mine = await create(w, { type: "markdown", title: "Mine" });
        const theirs = await create(w, { type: "markdown", title: "Theirs" }, OTHER);
        const byPerson = (
            await w.artifacts.create(w.ctx, {
                type: "markdown",
                title: "A person's",
                files: await w.artifacts.stageFiles(w.ctx, [{ path: "index.md", text: "# Hi\n" }]),
                author: { kind: "user" },
            })
        ).artifact;
        const writeTool = await w.tool(AGENT, "write_artifact_file");
        const edit = await w.tool(AGENT, "edit_artifact_file");
        const update = await w.tool(AGENT, "update_artifact");
        const readFile = await w.tool(AGENT, "read_artifact_file");
        const writeArgs = (artifactId: string) => ({
            artifactId,
            path: "index.md",
            content: "# x\n",
        });
        const editArgs = (artifactId: string) => ({
            artifactId,
            path: "index.md",
            old_string: "#",
            new_string: "##",
        });

        for (const [artifact, reviewed] of [
            [mine, false],
            [theirs, true],
            [byPerson, true],
        ] as const) {
            expect(await writeTool.shouldReviewInAutoMode(writeArgs(artifact.id), w.ctx)).toBe(
                reviewed,
            );
            expect(await edit.shouldReviewInAutoMode(editArgs(artifact.id), w.ctx)).toBe(reviewed);
            const retitle = { artifactId: artifact.id, title: "T" };
            expect(await update.shouldReviewInAutoMode(retitle, w.ctx)).toBe(reviewed);
            // The catalog never needs the machine, so an approved write is never lent Full access.
            expect(await update.shouldRunInFullAccessInAutoMode?.(retitle, w.ctx)).toBe(false);
            const readArgs = { artifactId: artifact.id, path: "index.md" };
            expect(await readFile.shouldReviewInAutoMode(readArgs, w.ctx)).toBe(false);
        }
        expect(writeTool.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(edit.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(writeTool.describeAutoPermissionAction?.(writeArgs(theirs.id), w.ctx)).toContain(
            `writing "index.md" in a new version of artifact "${theirs.id}", which this agent did not create, published in this installation's shared artifact catalog for everyone who uses it`,
        );
        // Copying a file from outside the workspace is what needs the machine.
        const outside = { artifactId: mine.id, files: [{ fromPath: "/etc/photo.png" }] };
        expect(await update.shouldReviewInAutoMode(outside, w.ctx)).toBe(true);
        expect(await update.shouldRunInFullAccessInAutoMode?.(outside, w.ctx)).toBe(true);

        // Read only writes nothing; Workspace write writes only the agent's own artifacts.
        const readOnly = withAgentPermissionMode(w.ctx, "read_only");
        await expect(call(readOnly, writeTool, writeArgs(mine.id), { id: "ro1" })).rejects.toThrow(
            "Read only mode cannot change artifacts.",
        );
        await expect(
            call(readOnly, await w.tool(AGENT, "create_artifact"), {
                type: "markdown",
                title: "No",
            }),
        ).rejects.toThrow("Read only mode cannot create artifacts.");
        const workspaceWrite = withAgentPermissionMode(w.ctx, "workspace_write");
        await expect(
            call(workspaceWrite, edit, editArgs(theirs.id), { id: "ww1" }),
        ).rejects.toThrow(
            `Workspace write mode cannot change artifact ${theirs.id}, which you did not create.`,
        );
        await expect(
            call(workspaceWrite, update, { artifactId: byPerson.id, title: "No" }, { id: "ww2" }),
        ).rejects.toThrow("which you did not create");
        await expect(
            call(workspaceWrite, writeTool, writeArgs(mine.id), { id: "ww3" }),
        ).resolves.toMatchObject({ changed: true });
        expect((await w.artifacts.get(w.ctx, theirs.id))?.latestVersion).toBe(1);
        // Auto has reviewed the write before it runs, and Full access needs no review.
        for (const [mode, id] of [
            ["auto", "a1"],
            ["full_access", "f1"],
        ] as const) {
            const written = (await call(
                withAgentPermissionMode(w.ctx, mode),
                writeTool,
                { artifactId: theirs.id, path: "index.md", content: `# by ${mode}\n` },
                { id },
            )) as WrittenFile;
            expect(written.changed).toBe(true);
        }
        expect((await w.artifacts.getVersion(w.ctx, theirs.id, "latest")).createdBy).toEqual({
            kind: "agent",
            agentId: AGENT,
            botId: BOT,
        });
        expect(await w.artifacts.get(w.ctx, theirs.id)).toMatchObject({
            createdBy: { kind: "agent", agentId: OTHER },
        });
    });

    it("always has Auto review a deletion, and nothing writes a deleted artifact", async () => {
        const w = await world("artifact-tools-delete");
        const tool = await w.tool(AGENT, "create_artifact");
        const update = await w.tool(AGENT, "update_artifact");
        const remove = await w.tool(AGENT, "delete_artifact");
        w.machine.writeBuffer("/workspace/inside.png", imageBytes("inside"));
        const bare = { type: "markdown", title: "Bare" };
        const inside = { type: "image", title: "In", files: [{ fromPath: "inside.png" }] };
        const outside = { type: "image", title: "Out", files: [{ fromPath: "/etc/photo.png" }] };

        for (const [args, crosses] of [
            [bare, false],
            [inside, false],
            [outside, true],
        ] as const) {
            expect(await tool.shouldReviewInAutoMode(args, w.ctx)).toBe(crosses);
            expect(await tool.shouldRunInFullAccessInAutoMode?.(args, w.ctx)).toBe(crosses);
        }
        expect(tool.describeAutoPermissionAction?.(outside, w.ctx)).toContain(
            '"/etc/photo.png" from this machine',
        );

        const artifact = await create(w, bare);
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
        await expect(write(w, artifact.id, "index.md", "# Back\n")).rejects.toThrow(
            "The artifact was deleted, so it cannot change.",
        );
        await expect(write(w, "nosuchartifact", "index.md", "# Back\n")).rejects.toThrow(
            "The artifact was not found.",
        );
        const read = await w.tool(AGENT, "read_artifact");
        expect(textOf(read, await call(w.ctx, read, { artifactId: artifact.id }))).toContain(
            "no longer available",
        );
    });
});
