import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { SkillsModule, skillNameSchema } from "../../sources/skills/index.js";
import {
    MAX_SKILL_COUNT,
    MAX_SKILL_DOCUMENT_BYTES,
    MAX_SKILL_OUTPUT_CHARACTERS,
} from "../../sources/skills/Skills.js";
import { parseSkillFrontmatter } from "../../sources/skills/impl/parseSkillFrontmatter.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { scriptedComputeModule } from "../support/computeModule.js";

const ctx = createRootContext().named("skills-module-edge-test");
const agentId = "agent-edge";
const scope = { agent: { id: agentId } } as never;

function skill(name: string, description: string, body = "Instructions."): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

function moduleFor(compute: FakeCompute): SkillsModule {
    return new SkillsModule(scriptedComputeModule(async () => compute));
}

describe("SkillsModule edge cases", () => {
    it("uses the nearest project skill when several project roots define one name", async () => {
        const compute = new FakeCompute("/workspace/packages/app");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/review/SKILL.md",
            skill("review", "Repository review.", "Repository instructions."),
        );
        compute.write(
            "/workspace/packages/.agents/skills/review/SKILL.md",
            skill("review", "Package review.", "Package instructions."),
        );
        compute.write(
            "/workspace/packages/app/.agents/skills/review/SKILL.md",
            skill("review", "App review.", "App instructions."),
        );

        await expect(moduleFor(compute).list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "App review.",
                    location: "/workspace/packages/app/.agents/skills/review/SKILL.md",
                    name: "review",
                    source: "project",
                },
            ],
        });
        await expect(
            moduleFor(compute).read(ctx, agentId, { name: "review" }),
        ).resolves.toMatchObject({
            content: expect.stringContaining("App instructions."),
        });
    });

    it("reads filesystem documents with the bounded, no-follow read contract", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/read/SKILL.md",
            skill("read", "Read me.", "Current body."),
        );
        const calls: unknown[] = [];
        const readFileBuffer = compute.fs.readFileBuffer;
        compute.fs.readFileBuffer = async (permissions, path, options) => {
            calls.push(options);
            return await readFileBuffer(permissions, path, options);
        };

        await expect(
            moduleFor(compute).read(ctx, agentId, { name: "read" }),
        ).resolves.toMatchObject({
            content: expect.stringContaining("Current body."),
        });
        expect(calls.at(-1)).toEqual({
            maxBytes: MAX_SKILL_DOCUMENT_BYTES,
            noFollow: true,
        });
    });

    it("discovers changes and removals without a persistent catalog", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/live/SKILL.md",
            skill("live", "First description.", "First body."),
        );
        const module = moduleFor(compute);
        await expect(module.list(ctx, agentId)).resolves.toMatchObject({
            skills: [{ description: "First description." }],
        });

        compute.write(
            "/workspace/.agents/skills/live/SKILL.md",
            skill("live", "Second description.", "Second body."),
        );
        await expect(module.list(ctx, agentId)).resolves.toMatchObject({
            skills: [{ description: "Second description." }],
        });
        compute.files.delete("/workspace/.agents/skills/live/SKILL.md");
        await expect(module.list(ctx, agentId)).resolves.toEqual({ skills: [] });
        await expect(module.read(ctx, agentId, { name: "live" })).rejects.toThrow(
            'Unknown skill "live"',
        );
    });

    it("keeps malformed or unreadable entries from hiding valid siblings", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/good/SKILL.md",
            skill("good", "A valid skill.", "Good body."),
        );
        compute.write("/workspace/.agents/skills/no-frontmatter/SKILL.md", "plain text");
        compute.write(
            "/workspace/.agents/skills/bad-name/SKILL.md",
            skill("../escape", "Invalid name.", "Bad body."),
        );
        compute.write(
            "/workspace/.agents/skills/bad-description/SKILL.md",
            "---\nname: bad-description\ndescription: 42\n---\n\nBad body.",
        );
        const originalRead = compute.fs.readFileBuffer;
        compute.fs.readFileBuffer = async (permissions, path, options) => {
            if (path.endsWith("/unreadable/SKILL.md")) throw new Error("permission denied");
            return await originalRead(permissions, path, options);
        };
        compute.write(
            "/workspace/.agents/skills/unreadable/SKILL.md",
            skill("unreadable", "Unreadable.", "Never returned."),
        );

        await expect(moduleFor(compute).list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "A valid skill.",
                    location: "/workspace/.agents/skills/good/SKILL.md",
                    name: "good",
                    source: "project",
                },
            ],
        });
    });

    it("does not treat a root-level SKILL.md as a child skill document", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/SKILL.md",
            skill("root-file", "Root file.", "Should not be a skill."),
        );
        compute.write(
            "/workspace/.agents/skills/child/SKILL.md",
            skill("child", "Child skill.", "Child body."),
        );

        await expect(moduleFor(compute).list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "Child skill.",
                    location: "/workspace/.agents/skills/child/SKILL.md",
                    name: "child",
                    source: "project",
                },
            ],
        });
    });

    it("treats a skills root reached through a symlink as the skill itself", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.directories.add("/external/linked");
        compute.write(
            "/external/linked/SKILL.md",
            skill("linked", "Linked skill.", "Linked body."),
        );
        compute.links.set("/workspace/.agents/skills", "/external/linked");

        await expect(moduleFor(compute).list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "Linked skill.",
                    location: "/external/linked/SKILL.md",
                    name: "linked",
                    source: "project",
                },
            ],
        });
    });

    it("handles filesystem failures at each discovery boundary", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/good/SKILL.md",
            skill("good", "Good skill.", "Good body."),
        );
        const originalReaddirPage = compute.fs.readdirPage;
        compute.fs.readdirPage = async (permissions, path, options) => {
            if (path === "/home/agent/.agents/skills") throw new Error("home unavailable");
            return await originalReaddirPage(permissions, path, options);
        };
        const originalLstat = compute.fs.lstat;
        compute.fs.lstat = async (permissions, path) => {
            if (path.endsWith("/broken")) throw new Error("gone");
            return await originalLstat(permissions, path);
        };
        compute.links.set("/workspace/.agents/skills/broken", "/missing");

        await expect(moduleFor(compute).list(ctx, agentId)).resolves.toMatchObject({
            skills: [{ name: "good" }],
        });
    });

    it("rejects path traversal in a hostile directory page", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.directories.add("/workspace/.agents/skills");
        const escaped = "/workspace/.agents/outside/SKILL.md";
        compute.write(escaped, skill("outside", "Escaped skill.", "Escaped body."));
        const originalReaddirPage = compute.fs.readdirPage;
        compute.fs.readdirPage = async (permissions, path, options) => {
            if (path === "/workspace/.agents/skills") {
                return { entries: ["foo/../../outside"], hasMore: false };
            }
            return await originalReaddirPage(permissions, path, options);
        };

        await expect(moduleFor(compute).list(ctx, agentId)).resolves.toEqual({ skills: [] });
    });

    it("ignores malformed directory-page results instead of throwing", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.directories.add("/workspace/.agents/skills");
        const originalReaddirPage = compute.fs.readdirPage;
        compute.fs.readdirPage = async (permissions, path, options) => {
            if (path === "/workspace/.agents/skills") {
                return { entries: 42, hasMore: false } as never;
            }
            return await originalReaddirPage(permissions, path, options);
        };

        await expect(moduleFor(compute).list(ctx, agentId)).resolves.toEqual({ skills: [] });
    });

    it("bounds list output and keeps every page reachable", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        for (let index = 0; index < MAX_SKILL_COUNT; index += 1) {
            const name = `skill-${String(index).padStart(3, "0")}`;
            compute.write(
                `/workspace/.agents/skills/${name}/SKILL.md`,
                skill(name, "d".repeat(1_024), "Body."),
            );
        }
        const module = moduleFor(compute);
        const names: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await module.list(ctx, agentId, {
                ...(cursor === undefined ? {} : { cursor }),
                limit: MAX_SKILL_COUNT,
            });
            expect(page.skills.length).toBeGreaterThan(0);
            expect(page.skills.length).toBeLessThanOrEqual(MAX_SKILL_COUNT);
            expect(
                page.nextCursor === undefined || Number(page.nextCursor) > Number(cursor ?? "0"),
            ).toBe(true);
            const previousNames = new Set(names);
            expect(page.skills.every((entry) => !previousNames.has(entry.name))).toBe(true);
            names.push(...page.skills.map((entry) => entry.name));
            cursor = page.nextCursor;
        } while (cursor !== undefined);
        expect(names).toHaveLength(MAX_SKILL_COUNT);
        expect(new Set(names).size).toBe(MAX_SKILL_COUNT);

        const first = await module.list(ctx, agentId);
        expect(first.skills.length).toBeGreaterThan(0);
        expect(first.skills.length).toBeLessThanOrEqual(MAX_SKILL_COUNT);
        const hooks = await resolveModuleHooks(ctx, module);
        const listTool = (await hooks.tools!(ctx, scope)).find(
            (tool) => tool.name === "list_skills",
        );
        if (listTool === undefined) throw new Error("Expected list_skills.");
        const rendered = listTool
            .toLLM(first)
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
        expect(rendered.length).toBeLessThanOrEqual(MAX_SKILL_OUTPUT_CHARACTERS);
    });

    it("supports filtered paging and cursors beyond the final match", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        for (const [name, description] of [
            ["alpha", "Shared"],
            ["beta", "Other"],
            ["gamma", "Shared"],
        ] as const) {
            compute.write(
                `/workspace/.agents/skills/${name}/SKILL.md`,
                skill(name, `${description} description.`),
            );
        }
        const module = moduleFor(compute);
        await expect(module.list(ctx, agentId, { query: " shared ", limit: 1 })).resolves.toEqual({
            skills: [
                {
                    description: "Shared description.",
                    location: "/workspace/.agents/skills/alpha/SKILL.md",
                    name: "alpha",
                    source: "project",
                },
            ],
            nextCursor: "1",
        });
        await expect(
            module.list(ctx, agentId, { query: "shared", cursor: "1", limit: 1 }),
        ).resolves.toEqual({
            skills: [
                {
                    description: "Shared description.",
                    location: "/workspace/.agents/skills/gamma/SKILL.md",
                    name: "gamma",
                    source: "project",
                },
            ],
        });
        await expect(module.list(ctx, agentId, { cursor: "9999999999" })).resolves.toEqual({
            skills: [],
        });
    });

    it("validates list and read inputs before resolving compute", async () => {
        let resolveCalls = 0;
        const module = new SkillsModule(
            scriptedComputeModule(async () => {
                resolveCalls += 1;
                return new FakeCompute();
            }),
        );
        await expect(module.list(ctx, agentId, { limit: 0 } as never)).rejects.toThrow(
            "Skill list input is invalid",
        );
        await expect(module.list(ctx, agentId, { cursor: "-1" } as never)).rejects.toThrow(
            "Skill list input is invalid",
        );
        await expect(module.read(ctx, agentId, { name: "../escape" } as never)).rejects.toThrow(
            "Skill read input is invalid",
        );
        expect(resolveCalls).toBe(0);
    });

    it("routes list and read tools through the same public operations", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/one/SKILL.md",
            skill("one", "One skill.", "Complete one body."),
        );
        const module = moduleFor(compute);
        const hooks = await resolveModuleHooks(ctx, module);
        const tools = await hooks.tools!(ctx, scope);
        const listTool = tools.find((tool) => tool.name === "list_skills");
        const readTool = tools.find((tool) => tool.name === "read_skill");
        if (listTool === undefined || readTool === undefined) {
            throw new Error("Expected both skill tools.");
        }

        const listed = await listTool.execute(ctx, {}, undefined as never);
        await expect(module.list(ctx, agentId, {})).resolves.toEqual(listed);
        expect(
            listTool
                .toLLM(listed)
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("\n"),
        ).toContain("one — One skill.");

        const read = await readTool.execute(ctx, { name: "one" }, undefined as never);
        await expect(module.read(ctx, agentId, { name: "one" })).resolves.toEqual(read);
        expect(
            readTool
                .toLLM(read)
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("\n"),
        ).toContain("Complete one body.");
    });

    it("does not retain mutable list results between live reads", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/one/SKILL.md",
            skill("one", "Original description.", "Body."),
        );
        const module = moduleFor(compute);
        const first = await module.list(ctx, agentId);
        const firstEntry = first.skills[0]!;
        firstEntry.description = "Mutated by caller.";
        first.skills.splice(0, 1);

        await expect(module.list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "Original description.",
                    location: "/workspace/.agents/skills/one/SKILL.md",
                    name: "one",
                    source: "project",
                },
            ],
        });
    });

    it("escapes skill metadata in system instructions", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/safe/SKILL.md",
            skill("safe", "<tag>& value", "Body."),
        );
        const hooks = await resolveModuleHooks(ctx, moduleFor(compute));
        const instructions = await hooks.instructions!(ctx, scope);
        expect(instructions).toContain("<description>&lt;tag&gt;&amp; value</description>");
        expect(instructions).not.toContain("<description><tag>& value</description>");
    });

    it("skips malformed flow-map and oversized frontmatter files while keeping siblings", async () => {
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/good/SKILL.md",
            skill("good", "Good skill.", "Good body."),
        );
        compute.write(
            "/workspace/.agents/skills/bad-flow/SKILL.md",
            "---\n{name: bad, description: [unterminated\n---\nBody",
        );
        compute.write(
            "/workspace/.agents/skills/too-long/SKILL.md",
            `---\nname: too-long\ndescription: ${"x".repeat(1_025)}\n---\nBody`,
        );

        await expect(moduleFor(compute).list(ctx, agentId)).resolves.toMatchObject({
            skills: [{ name: "good" }],
        });
    });

    it("parses YAML duplicate keys, quoted values, and unknown metadata", () => {
        expect(
            parseSkillFrontmatter(
                [
                    "---",
                    'name: "quoted-name" # inline comment',
                    "description: first",
                    "  second",
                    "unknown: ignored",
                    "description: 'last: value # kept'",
                    "---",
                    "Body.",
                ].join("\n"),
                "fallback",
            ),
        ).toEqual({
            name: "quoted-name",
            description: "last: value # kept",
        });
    });

    it("reads disable-model-invocation only as a plain YAML boolean", () => {
        expect(
            parseSkillFrontmatter(
                "---\nname: deploy\ndescription: Deploy.\ndisable-model-invocation: true # user only\n---\nBody",
                "fallback",
            ),
        ).toEqual({ name: "deploy", description: "Deploy.", disableModelInvocation: true });
        expect(
            parseSkillFrontmatter(
                "---\n{ name: deploy, description: Deploy., disable-model-invocation: TRUE }\n---\nBody",
                "fallback",
            ),
        ).toEqual({ name: "deploy", description: "Deploy.", disableModelInvocation: true });
        for (const value of ["false", '"true"', "yes", "1", "~"]) {
            expect(
                parseSkillFrontmatter(
                    `---\nname: deploy\ndescription: Deploy.\ndisable-model-invocation: ${value}\n---\nBody`,
                    "fallback",
                ),
            ).toEqual({ name: "deploy", description: "Deploy." });
        }
        // The last duplicate key wins, whichever kind of scalar it is.
        expect(
            parseSkillFrontmatter(
                "---\nname: deploy\ndescription: Deploy.\ndisable-model-invocation: true\ndisable-model-invocation: no\n---\nBody",
                "fallback",
            ),
        ).toEqual({ name: "deploy", description: "Deploy." });
    });

    it("accepts YAML document markers with comments", () => {
        expect(
            parseSkillFrontmatter(
                "--- # skill metadata\nname: commented\ndescription: Valid.\n--- # end metadata\nBody",
                "fallback",
            ),
        ).toEqual({
            name: "commented",
            description: "Valid.",
        });
    });

    it("parses CR-only frontmatter and preserves block scalar semantics", () => {
        expect(
            parseSkillFrontmatter(
                "---\rname: block\rdescription: |-\r  first\r  second\r---\rBody",
                "fallback",
            ),
        ).toEqual({
            name: "block",
            description: "first\nsecond",
        });
        expect(
            parseSkillFrontmatter(
                "---\nname: folded\ndescription: >+\n  first\n  second\n\n---\nBody",
                "fallback",
            ),
        ).toEqual({
            name: "folded",
            description: "first second\n\n",
        });
    });

    it("uses the directory name for non-string names but rejects invalid descriptions", () => {
        expect(
            parseSkillFrontmatter(
                "---\nname: 42\ndescription: A valid description.\n---\nBody",
                "directory-name",
            ),
        ).toEqual({
            name: "directory-name",
            description: "A valid description.",
        });
        expect(() =>
            parseSkillFrontmatter("---\nname: valid\ndescription: 42\n---\nBody", "valid"),
        ).not.toThrow();
        expect(
            parseSkillFrontmatter("---\nname: valid\ndescription: 42\n---\nBody", "valid"),
        ).toEqual({
            name: "valid",
            description: "",
        });
    });

    it("accepts the complete legal skill-name boundary and rejects path-like names", async () => {
        const legal = `a${"b".repeat(127)}`;
        expect(skillNameSchema.maxLength).toBe(128);
        expect(
            parseSkillFrontmatter(
                `---\nname: ${legal}\ndescription: Valid.\n---\nBody`,
                "fallback",
            ),
        ).toEqual({ name: legal, description: "Valid." });
        const compute = new FakeCompute("/workspace");
        compute.directories.add("/workspace/.git");
        compute.write(
            "/workspace/.agents/skills/path-like/SKILL.md",
            skill("path/like", "Invalid.", "Body."),
        );
        await expect(moduleFor(compute).list(ctx, agentId)).resolves.toEqual({ skills: [] });
    });
});
