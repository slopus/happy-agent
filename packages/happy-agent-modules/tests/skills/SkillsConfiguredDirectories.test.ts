import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SkillsModule } from "../../sources/skills/index.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { scriptedComputeModule } from "../support/computeModule.js";
import { temporaryTestConfig } from "../support/configModule.js";

const ctx = createRootContext().named("skills-configured-directories-test");
const agentId = "agent";

function skill(name: string, description: string, body: string): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

describe("configured skill directories", () => {
    it("parses [skills] directories from the user happy.toml and resolves them against home", async () => {
        const config = await temporaryTestConfig(
            '[skills]\ndirectories = ["~/team-skills", "shared/skills", "/opt/skills"]\n',
            { environment: { HOME: "/home/tester" } },
        );
        expect(config.globalSkillDirectories).toEqual([
            "/home/tester/team-skills",
            "/home/tester/shared/skills",
            "/opt/skills",
        ]);
        expect(config.configuration.provenance["skills.directories"]).toBe("global");
        expect(
            config.projectSkillDirectories('[skills]\ndirectories = ["tools/skills"]\n'),
        ).toEqual(["tools/skills"]);
        expect(config.projectSkillDirectories('[defaults]\nmodel = "x"\n')).toEqual([]);
        expect(() => config.projectSkillDirectories("[skills]\ndirectories = 3\n")).toThrow();
    });

    it("leaves the machine list empty when nothing is configured", async () => {
        const config = await temporaryTestConfig();
        expect(config.globalSkillDirectories).toEqual([]);
    });

    it("discovers skills in project-configured folders relative to the project root", async () => {
        const config = await temporaryTestConfig();
        const machine = new FakeCompute("/workspace/packages/app");
        machine.directories.add("/workspace/.git");
        machine.write(
            "/workspace/happy.toml",
            '[skills]\ndirectories = ["tools/skills", "/shared/skills"]\n',
        );
        machine.write(
            "/workspace/tools/skills/deploy/SKILL.md",
            skill("deploy", "Deploy the service.", "Deploy instructions."),
        );
        machine.write(
            "/shared/skills/audit/SKILL.md",
            skill("audit", "Audit the code.", "Audit instructions."),
        );
        // The standard project root keeps precedence over a configured folder for the same name.
        machine.write(
            "/workspace/.agents/skills/deploy/SKILL.md",
            skill("deploy", "Standard deploy.", "Standard instructions."),
        );
        const module = new SkillsModule(
            scriptedComputeModule(async () => machine),
            undefined,
            config,
        );
        await expect(module.list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "Audit the code.",
                    location: "/shared/skills/audit/SKILL.md",
                    name: "audit",
                    source: "project",
                },
                {
                    description: "Standard deploy.",
                    location: "/workspace/.agents/skills/deploy/SKILL.md",
                    name: "deploy",
                    source: "project",
                },
            ],
        });
    });

    it("ignores an invalid project happy.toml without hiding standard skills", async () => {
        const config = await temporaryTestConfig();
        const machine = new FakeCompute("/workspace");
        machine.directories.add("/workspace/.git");
        machine.write("/workspace/happy.toml", "[skills]\ndirectories = 42\n");
        machine.write(
            "/workspace/.agents/skills/review/SKILL.md",
            skill("review", "Review.", "Instructions."),
        );
        const module = new SkillsModule(
            scriptedComputeModule(async () => machine),
            undefined,
            config,
        );
        await expect(module.list(ctx, agentId)).resolves.toMatchObject({
            skills: [{ name: "review" }],
        });
    });

    it("scans machine-configured folders only on the daemon's native filesystem", async () => {
        const config = await temporaryTestConfig('[skills]\ndirectories = ["/opt/skills"]\n', {
            environment: { HOME: "/home/agent" },
        });
        const machine = new FakeCompute("/workspace");
        machine.directories.add("/workspace/.git");
        machine.write(
            "/opt/skills/lint/SKILL.md",
            skill("lint", "Lint the code.", "Lint instructions."),
        );
        const remote = new SkillsModule(
            scriptedComputeModule(async () => machine),
            undefined,
            config,
        );
        await expect(remote.list(ctx, agentId)).resolves.toEqual({ skills: [] });

        const compute = scriptedComputeModule(async () => machine);
        vi.spyOn(compute, "fileSystemIdentity").mockReturnValue("native-test");
        const native = new SkillsModule(compute, undefined, config);
        await expect(native.list(ctx, agentId)).resolves.toEqual({
            skills: [
                {
                    description: "Lint the code.",
                    location: "/opt/skills/lint/SKILL.md",
                    name: "lint",
                    source: "user",
                },
            ],
        });
        await expect(native.read(ctx, agentId, { name: "lint" })).resolves.toMatchObject({
            content: expect.stringContaining("Lint instructions."),
        });
    });
});
