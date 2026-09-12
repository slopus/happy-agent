import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";
import type { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { GlobalSkillsModule } from "../../sources/skills/GlobalSkillsModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const document = (name = "review", description = "Review changes.") =>
    `---\nname: ${name}\ndescription: ${description}\n---\nRead the diff.\n`;
async function fixture() {
    const home = await mkdtemp(join(tmpdir(), "global-skills-"));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const root = join(home, ".agents", "skills");
    const config = await ConfigModule.load(join(home, ".happy"), {
        environment: { ...process.env, HOME: home },
    });
    const durable = { register: vi.fn(), invoke: vi.fn(async () => ({ status: "created" })) };
    const skills = new GlobalSkillsModule(config, durable as unknown as DurableFunctionsModule);
    const db = moduleDatabase(skills.migrations, "global-skills-test");
    ensureAgentDatabaseConnection(db.database);
    cleanup.push(async () => db.close());
    cleanup.push(() => skills.close());
    await db.ready;
    await skills.beforeStart(db.context);
    const events: unknown[] = [];
    skills.onUpdated((_ctx, event) => {
        events.push(event);
    });
    const install = async (path: string, content = document()) => {
        await mkdir(join(root, path), { recursive: true });
        await writeFile(join(root, path, "SKILL.md"), content);
    };
    return { home, root, config, skills, ctx: db.context, events, install, durable };
}

describe("global skill management", () => {
    it("keeps aliased installation preferences independent while matching discovery's fallback name", async () => {
        const f = await fixture();
        await f.install("original", "---\ndescription: A linked skill.\n---\nInstructions.");
        await symlink(join(f.root, "original"), join(f.root, "alias"));
        const list = await f.skills.list(f.ctx);
        expect(list.skills.map((skill) => skill.name)).toEqual(["original", "original"]);
        const [alias, original] = list.skills;
        await f.skills.setEnabled(f.ctx, original!.id, false, original!.version);
        expect(await f.skills.unavailableLocations(f.ctx)).toEqual(new Set());
        await f.skills.setEnabled(f.ctx, alias!.id, false, alias!.version);
        expect(await f.skills.unavailableLocations(f.ctx)).toEqual(
            new Set([join(f.root, "original", "SKILL.md")]),
        );
    });

    it("keeps unchanged scans stable, separates nested files, and normalizes only parsed bodies", async () => {
        const f = await fixture();
        const content = document().replaceAll("\n", "\r\n");
        await f.install("parent", content);
        await f.install("parent/child", document("child"));
        const first = await f.skills.list(f.ctx);
        f.events.length = 0;
        expect(await f.skills.list(f.ctx)).toEqual(first);
        expect(f.events).toEqual([]);
        const parent = first.skills[0]!;
        expect(await f.skills.read(f.ctx, parent.id)).toMatchObject({
            content,
            instructions: "Read the diff.\n",
        });
        expect((await f.skills.files(f.ctx, parent.id)).files.map((file) => file.path)).toEqual([
            "SKILL.md",
        ]);
        await writeFile(join(f.root, "parent", "support"), "one");
        const current = (await f.skills.list(f.ctx)).skills[0]!;
        const page = await f.skills.files(f.ctx, parent.id, { limit: 1 });
        await writeFile(join(f.root, "parent", "support"), "two");
        await expect(
            f.skills.files(f.ctx, parent.id, { pageCursor: page.nextPageCursor! }),
        ).rejects.toMatchObject({ status: 409 });
        expect((await f.skills.list(f.ctx)).skills[0]!.version).not.toBe(current.version);
        await f.install("parent/.hidden", document("not-installed"));
        expect((await f.skills.list(f.ctx)).skills).toHaveLength(2);
        expect((await f.skills.files(f.ctx, parent.id)).files.map((file) => file.path)).toContain(
            ".hidden/SKILL.md",
        );
    });

    it("bounds documents and binary reads and refuses a failed root scan", async () => {
        const f = await fixture();
        await f.install("large", document() + "x".repeat(256 * 1024));
        await f.install("invalid-utf8");
        await writeFile(join(f.root, "invalid-utf8", "SKILL.md"), Buffer.from([0xff, 0xfe]));
        const list = await f.skills.list(f.ctx);
        for (const skill of list.skills) {
            expect(await f.skills.read(f.ctx, skill.id)).toMatchObject({
                skill: { status: "unreadable" },
                content: null,
                instructions: null,
            });
        }
        await writeFile(join(f.root, "large", "binary"), Buffer.alloc(8 * 1024 * 1024 + 1));
        await expect(f.skills.readFile(f.ctx, list.skills[1]!.id, "binary")).rejects.toMatchObject({
            status: 413,
        });
        await rename(f.root, `${f.root}-saved`);
        await writeFile(f.root, "not a directory");
        await expect(f.skills.list(f.ctx)).rejects.toMatchObject({ status: 503 });
    });

    it("discovers a previously missing root, parses documents, and keeps broken and duplicate skills", async () => {
        const f = await fixture();
        expect((await f.skills.list(f.ctx)).skills).toEqual([]);
        await f.install("first");
        await f.install("second");
        await f.install("broken", "not frontmatter");
        const list = await f.skills.list(f.ctx);
        expect(list.skills.map((skill) => [skill.path, skill.status])).toEqual([
            ["broken", "invalid"],
            ["first", "ready"],
            ["second", "ready"],
        ]);
        expect(new Set(list.skills.map((skill) => skill.id)).size).toBe(3);
        expect(await f.skills.read(f.ctx, list.skills[1]!.id)).toMatchObject({
            content: document(),
            instructions: "Read the diff.\n",
        });
    });

    it("disables without deleting, rejects stale updates, and composes with rollback", async () => {
        const f = await fixture();
        await f.install("review");
        const first = (await f.skills.list(f.ctx)).skills[0]!;
        f.events.length = 0;
        await expect(
            f.ctx.inTx(async (ctx) => {
                await f.skills.setEnabled(ctx, first.id, false, first.version, "rolled-back");
                expect((await f.skills.get(ctx, first.id)).enabled).toBe(false);
                expect(f.events).toEqual([]);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect((await f.skills.get(f.ctx, first.id)).enabled).toBe(true);
        expect(f.events).toEqual([]);
        const disabled = await f.skills.setEnabled(f.ctx, first.id, false, first.version, "toggle");
        expect(disabled.enabled).toBe(false);
        expect(f.events).toEqual([{ skillIds: [first.id], paths: [], mutationId: "toggle" }]);
        expect(await readFile(join(f.root, "review", "SKILL.md"), "utf8")).toBe(document());
        expect((await f.skills.read(f.ctx, first.id)).content).toBe(document());
        await expect(
            f.skills.setEnabled(f.ctx, first.id, true, first.version),
        ).rejects.toMatchObject({ status: 409, details: { currentVersion: disabled.version } });
        f.events.length = 0;
        expect(await f.skills.setEnabled(f.ctx, first.id, false, disabled.version)).toEqual(
            disabled,
        );
        expect(f.events).toEqual([]);
    });

    it("tracks supporting-file edits and atomic replacements even while disabled", async () => {
        const f = await fixture();
        await f.install("review");
        const first = (await f.skills.list(f.ctx)).skills[0]!;
        const disabled = await f.skills.setEnabled(f.ctx, first.id, false, first.version);
        await writeFile(join(f.root, "review", "guide.txt"), "first");
        const changed = (await f.skills.list(f.ctx)).skills[0]!;
        expect(changed.version > disabled.version).toBe(true);
        expect(changed.enabled).toBe(false);
        expect((await f.skills.files(f.ctx, first.id)).files.map((file) => file.path)).toEqual([
            "SKILL.md",
            "guide.txt",
        ]);
        expect((await f.skills.readFile(f.ctx, first.id, "guide.txt")).toString()).toBe("first");
        await writeFile(join(f.root, "review", "replace"), document("renamed"));
        await rename(join(f.root, "review", "replace"), join(f.root, "review", "SKILL.md"));
        expect((await f.skills.list(f.ctx)).skills[0]).toMatchObject({
            id: first.id,
            name: "renamed",
            enabled: false,
        });
    });

    it("invalidates paging and retains identity and enablement after remove/reinstall", async () => {
        const f = await fixture();
        await f.install("a");
        await f.install("b");
        const page = await f.skills.list(f.ctx, { limit: 1 });
        const a = page.skills[0]!;
        await f.skills.setEnabled(f.ctx, a.id, false, a.version);
        await expect(
            f.skills.list(f.ctx, { pageCursor: page.nextPageCursor! }),
        ).rejects.toMatchObject({ status: 409 });
        await rm(join(f.root, "a"), { recursive: true });
        expect((await f.skills.list(f.ctx)).skills).toHaveLength(1);
        await expect(f.skills.get(f.ctx, a.id)).rejects.toMatchObject({ status: 404 });
        await f.install("a");
        expect((await f.skills.list(f.ctx)).skills[0]).toMatchObject({ id: a.id, enabled: false });
    });

    it("rejects traversal and escaping symlinks, but supports an installed directory symlink", async () => {
        const f = await fixture();
        await f.install("review");
        await writeFile(join(f.home, "private"), "private");
        await symlink(join(f.home, "private"), join(f.root, "review", "escape"));
        const first = (await f.skills.list(f.ctx)).skills[0]!;
        await expect(f.skills.readFile(f.ctx, first.id, "../private")).rejects.toMatchObject({
            status: 400,
        });
        await expect(f.skills.readFile(f.ctx, first.id, "escape")).rejects.toMatchObject({
            status: 403,
        });
        const external = join(f.home, "installed");
        await mkdir(external);
        await writeFile(join(external, "SKILL.md"), document("linked"));
        await symlink(external, join(f.root, "linked"));
        const linked = (await f.skills.list(f.ctx)).skills.find(
            (skill) => skill.name === "linked",
        )!;
        expect((await f.skills.read(f.ctx, linked.id)).instructions).toBe("Read the diff.\n");
    });
});
