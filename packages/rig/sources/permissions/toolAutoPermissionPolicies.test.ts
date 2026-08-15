import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentContext } from "../agent/context/AgentContext.js";
import { claudeTaskInputTool } from "../agent/tools/claude/TaskInput.js";
import { codexWorkflowTool } from "../tools/workflows/workflowTools.js";

describe("tool-owned Auto permission policies", () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        await Promise.all(
            temporaryDirectories
                .splice(0)
                .map((path) => rm(path, { force: true, recursive: true })),
        );
    });

    it("elevates input only when a background task uses secrets", async () => {
        const context = await makeContext(temporaryDirectories);
        Object.assign(context, {
            bash: {
                sessionUsesSecrets: (sessionId: number) => sessionId === 1,
            },
        });

        expect(
            await claudeTaskInputTool.shouldRunInFullAccessInAutoMode(
                { input: "git push\n", task_id: "1" },
                context,
            ),
        ).toBe(true);
        expect(
            await claudeTaskInputTool.shouldRunInFullAccessInAutoMode(
                { input: "continue\n", task_id: "2" },
                context,
            ),
        ).toBe(false);
    });

    it("keeps workflow script path boundary checks", async () => {
        const context = await makeContext(temporaryDirectories);
        const inside = join(context.fs.cwd, "workflow.py");
        const outside = join(context.fs.cwd, "..", "workflow.py");
        await writeFile(inside, "'done'");

        expect(
            await codexWorkflowTool.shouldReviewInAutoMode({ scriptPath: inside }, context),
        ).toBe(false);
        expect(
            await codexWorkflowTool.shouldReviewInAutoMode({ scriptPath: outside }, context),
        ).toBe(true);
        expect(
            await codexWorkflowTool.shouldRunInFullAccessInAutoMode(
                { scriptPath: outside },
                context,
            ),
        ).toBe(true);
        expect(
            codexWorkflowTool.describeAutoPermissionAction?.({ scriptPath: outside }, context),
        ).toBe(
            `reading workflow script ${JSON.stringify(outside)}. Access: unrestricted filesystem access outside the workspace sandbox`,
        );
    });
});

async function makeContext(temporaryDirectories: string[]): Promise<AgentContext> {
    const root = await mkdtemp(join(tmpdir(), "rig-tool-auto-policy-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    await Promise.all([mkdir(cwd), mkdir(home)]);
    return { fs: { cwd, home } } as AgentContext;
}
