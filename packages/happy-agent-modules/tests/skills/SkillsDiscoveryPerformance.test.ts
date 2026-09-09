import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withAgentConfig, withAgentPermissionMode } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SkillsModule } from "../../sources/skills/index.js";
import { ComputeModule } from "../../sources/compute/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { scriptedComputeModule, testConfig } from "../support/computeModule.js";

const ctx = createRootContext().named("skill-discovery-performance");
const skillPath = "/workspace/.agents/skills/review/SKILL.md";
const document = "---\nname: review\ndescription: Review changes.\n---\nInstructions.";

function machine(): FakeCompute {
    const compute = new FakeCompute("/workspace");
    compute.directories.add("/workspace/.git");
    compute.write(skillPath, document);
    return compute;
}

describe("skill discovery work sharing", () => {
    it("coalesces scans across distinct real native computes in the same workspace", async () => {
        const directory = await mkdtemp(join(tmpdir(), "native-skills-discovery-"));
        const computeModule = new ComputeModule(testConfig, new SecretsModule());
        try {
            const root = join(directory, ".agents", "skills", "review");
            await mkdir(root, { recursive: true });
            await mkdir(join(directory, ".git"));
            await writeFile(join(root, "SKILL.md"), document);
            const nativeCtx = withAgentConfig(ctx, { modules: { compute: { cwd: directory } } });
            const ids = Array.from({ length: 32 }, (_, index) => `native-${index}`);
            const computes = await Promise.all(
                ids.map((id) => computeModule.resolve(nativeCtx, id)),
            );
            const reads = computes.map((compute) => {
                if (compute === undefined) throw new Error("Expected native compute.");
                // Discovery must not inspect the developer's personal skills in this fixture.
                compute.fs.home = join(directory, "empty-home");
                return vi.spyOn(compute.fs, "readFileBuffer");
            });
            const skills = new SkillsModule(computeModule);
            const results = await Promise.all(ids.map((id) => skills.slashCommands(nativeCtx, id)));
            expect(results.every((entries) => entries[0]?.name === "review")).toBe(true);
            expect(reads.reduce((total, read) => total + read.mock.calls.length, 0)).toBe(1);
        } finally {
            await computeModule.dispose(ctx);
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("reads each skill once during a concurrent 605-agent catalog load", async () => {
        const compute = machine();
        const read = vi.spyOn(compute.fs, "readFileBuffer");
        const skills = new SkillsModule(scriptedComputeModule(async () => compute));
        const results = await Promise.all(
            Array.from({ length: 605 }, (_, index) => skills.slashCommands(ctx, `agent-${index}`)),
        );
        expect(results.every((entries) => entries[0]?.name === "review")).toBe(true);
        expect(read).toHaveBeenCalledTimes(1);
    });

    it("does not reuse a completed scan after a skill changes, disappears, or reappears", async () => {
        const compute = machine();
        const skills = new SkillsModule(scriptedComputeModule(async () => compute));
        await skills.list(ctx, "agent-a");
        compute.write(skillPath, document.replace("Review changes.", "New description."));
        expect((await skills.list(ctx, "agent-b")).skills[0]?.description).toBe("New description.");
        compute.files.delete(skillPath);
        expect((await skills.list(ctx, "agent-a")).skills).toEqual([]);
        compute.write(skillPath, document);
        expect((await skills.list(ctx, "agent-a")).skills[0]?.name).toBe("review");
    });

    it("keeps identically named machines and different permission modes isolated", async () => {
        const first = machine();
        const second = machine();
        second.write(skillPath, document.replace("Review changes.", "Second machine."));
        const skills = new SkillsModule(
            scriptedComputeModule(async (_ctx, id) => (id === "first" ? first : second)),
        );
        const results = await Promise.all([skills.list(ctx, "first"), skills.list(ctx, "second")]);
        expect(results.map((result) => result.skills[0]?.description)).toEqual([
            "Review changes.",
            "Second machine.",
        ]);

        const read = first.fs.readFileBuffer.bind(first.fs);
        vi.spyOn(first.fs, "readFileBuffer").mockImplementation((permissions, path, options) => {
            if (permissions.mode === "read_only")
                return Promise.reject(new Error("Denied by this machine."));
            return read(permissions, path, options);
        });
        const [allowed, denied] = await Promise.all([
            skills.list(withAgentPermissionMode(ctx, "full_access"), "first"),
            skills.list(withAgentPermissionMode(ctx, "read_only"), "first"),
        ]);
        expect(allowed.skills).toHaveLength(1);
        expect(denied.skills).toEqual([]);
    });

    it("batches directory metadata instead of making a serial stat call per entry", async () => {
        const compute = machine();
        for (let index = 0; index < 60; index += 1) {
            compute.write(`/workspace/.agents/skills/review/reference-${index}.md`, "Reference.");
        }
        const stat = vi.spyOn(compute.fs, "lstat");
        const batch = vi.spyOn(compute.fs, "lstatMany");
        const skills = new SkillsModule(scriptedComputeModule(async () => compute));
        expect((await skills.list(ctx, "agent")).skills).toHaveLength(1);
        expect(batch).toHaveBeenCalled();
        expect(stat.mock.calls.filter(([, path]) => path.includes("reference-")).length).toBe(0);
    });

    it("retains individual failure isolation when a metadata batch fails", async () => {
        const compute = machine();
        vi.spyOn(compute.fs, "lstatMany").mockRejectedValue(new Error("Batch unavailable."));
        const skills = new SkillsModule(scriptedComputeModule(async () => compute));
        expect((await skills.list(ctx, "agent")).skills[0]?.name).toBe("review");
    });

    it("does not retain a failed filesystem observation in a later scan", async () => {
        const compute = machine();
        const read = vi
            .spyOn(compute.fs, "readFileBuffer")
            .mockRejectedValueOnce(new Error("File unavailable."));
        const skills = new SkillsModule(scriptedComputeModule(async () => compute));
        const first = await Promise.all([skills.list(ctx, "a"), skills.list(ctx, "b")]);
        expect(first.map((result) => result.skills)).toEqual([[], []]);
        expect((await skills.list(ctx, "a")).skills[0]?.name).toBe("review");
        expect(read).toHaveBeenCalledTimes(2);
    });
});
