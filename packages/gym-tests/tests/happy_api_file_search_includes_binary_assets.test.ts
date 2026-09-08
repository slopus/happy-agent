import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const running = new Set<AgentGym>();
const directories = new Set<string>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
    await Promise.all([...directories].map((root) => rm(root, { recursive: true, force: true })));
    directories.clear();
});

it.each([false, true])(
    "finds binary assets alongside source files (Git repository: %s)",
    async (gitRepository) => {
        // Outside the checkout: otherwise FFF finds its ancestor Git repository and the
        // supposed plain-directory case silently exercises the Git walker too.
        const root = await mkdtemp(join(tmpdir(), "happy-api-search-"));
        directories.add(root);
        await mkdir(join(root, "assets"));
        await mkdir(join(root, "src"));
        await writeFile(join(root, "assets/sample.bin"), new Uint8Array([0, 1, 128, 255]));
        await writeFile(join(root, "assets/sample.png"), new Uint8Array([0, 1, 128, 255]));
        await writeFile(join(root, "src/sample.ts"), "export const sample = true;\n");
        if (gitRepository) await execFile("git", ["init", "-b", "main", root]);

        const gym = await createAgentGym();
        running.add(gym);
        const project = (await gym.client.registerProject({ path: root })).project;
        await gym.waitUntil(async () => {
            const current = (await gym.client.getProject(project.id)).project;
            return current.initialization.status === "ready" ? current : undefined;
        }, "the search project to initialize");

        const result = await gym.client.searchFiles(project.id, { query: "sample", limit: 50 });

        expect(result.files).toEqual(
            expect.arrayContaining([
                { path: "assets/sample.bin", fileName: "sample.bin" },
                { path: "assets/sample.png", fileName: "sample.png" },
                { path: "src/sample.ts", fileName: "sample.ts" },
            ]),
        );
    },
);
