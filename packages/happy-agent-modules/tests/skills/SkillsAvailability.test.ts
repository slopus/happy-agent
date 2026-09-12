import { createRootContext } from "@steve.kite/stdlib";
import { expect, it, vi } from "vitest";
import { SkillsModule, type GlobalSkillsModule } from "../../sources/skills/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { scriptedComputeModule } from "../support/computeModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

it("filters pending global instructions without disabling same-name project or separate-machine skills", async () => {
    const ctx = createRootContext().named("skill-availability-test");
    const machine = new FakeCompute("/workspace");
    machine.directories.add("/workspace/.git");
    const location = "/home/agent/.agents/skills/review/SKILL.md";
    const content = "---\nname: review\ndescription: Global review.\n---\nGLOBAL_INSTRUCTIONS";
    machine.write(location, content);
    const compute = scriptedComputeModule(async () => machine);
    const identity = vi.spyOn(compute, "fileSystemIdentity").mockReturnValue("native-test");
    const unavailable = new Set<string>();
    const management = {
        managesHome: () => true,
        unavailableLocations: async () => new Set(unavailable),
    } as unknown as GlobalSkillsModule;
    const module = new SkillsModule(compute, management);
    const hooks = await resolveModuleHooks(ctx, module);
    const scope = {
        agent: { id: "agent" },
        runKV: { read: async () => [{ name: "review", location, content, messageId: "pending" }] },
    } as never;
    expect(await hooks.instructions!(ctx, scope)).toContain("GLOBAL_INSTRUCTIONS");
    unavailable.add(location);
    expect(await module.list(ctx, "agent")).toEqual({ skills: [] });
    await expect(module.read(ctx, "agent", { name: "review" })).rejects.toThrow("Unknown skill");
    expect(await hooks.instructions!(ctx, scope)).not.toContain("GLOBAL_INSTRUCTIONS");
    machine.write(
        "/workspace/.agents/skills/review/SKILL.md",
        "---\nname: review\ndescription: Project review.\n---\nPROJECT_INSTRUCTIONS",
    );
    expect(await module.read(ctx, "agent", { name: "review" })).toMatchObject({
        content: expect.stringContaining("PROJECT_INSTRUCTIONS"),
    });
    expect(await hooks.instructions!(ctx, scope)).toContain("Project review.");
    expect(await hooks.instructions!(ctx, scope)).not.toContain("GLOBAL_INSTRUCTIONS");
    identity.mockRestore();
    const independent = new SkillsModule(
        scriptedComputeModule(async () => machine),
        management,
    );
    machine.files.delete("/workspace/.agents/skills/review/SKILL.md");
    expect(await independent.read(ctx, "agent", { name: "review" })).toMatchObject({ content });
});
