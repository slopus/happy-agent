import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectFilesModule, type ProjectFileRoot } from "../../sources/files/index.js";
import type { GitModule } from "../../sources/git/index.js";
import {
    HAPPY_UPLOADS_RETENTION_MS,
    sweepHappyUploads,
} from "../../sources/happy/sweepHappyUploads.js";
import type { ProjectsModule } from "../../sources/projects/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import type { WorkspacesModule } from "../../sources/workspaces/index.js";
import { temporaryTestConfig } from "../support/configModule.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let directory: string;
let files: ProjectFilesModule;
let runners: RunnersModule;

beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "happy-uploads-sweep-")));
    runners = new RunnersModule(await temporaryTestConfig());
    files = new ProjectFilesModule(
        {} as ProjectsModule,
        {} as WorkspacesModule,
        { invalidate: vi.fn(), markChanged: vi.fn() } as unknown as GitModule,
        runners,
    );
});

afterEach(async () => {
    await files.close();
    await runners.close();
    await rm(directory, { force: true, recursive: true });
});

async function folder(name: string): Promise<ProjectFileRoot> {
    const root = join(directory, name);
    await mkdir(root);
    return { projectId: name, root };
}

async function upload(root: ProjectFileRoot, message: string, age: number): Promise<void> {
    const path = join(root.root, ".happy-uploads", message);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "1-a.png"), message);
    const at = new Date(NOW - age);
    await utimes(join(path, "1-a.png"), at, at);
    await utimes(path, at, at);
}

describe("sweeping Happy uploads", () => {
    it("removes messages past 30 days in every folder and keeps the uploads folders out of Git", async () => {
        const project = await folder("project");
        const bot = await folder("bot");
        const plain = await folder("plain");
        await upload(project, "expired", HAPPY_UPLOADS_RETENTION_MS + DAY);
        await upload(project, "recent", HAPPY_UPLOADS_RETENTION_MS - DAY);
        await upload(bot, "expired", 90 * DAY);
        // An ignore file someone already wrote stays exactly as it is.
        await writeFile(join(bot.root, ".happy-uploads", ".gitignore"), "custom\n");
        // A folder on a runner that is not there fails alone.
        const away: ProjectFileRoot = { projectId: "away", root: "/away", runnerId: "missing" };
        vi.spyOn(files, "roots").mockResolvedValue([away, project, bot, plain]);
        const ctx = createRootContext();

        await sweepHappyUploads(ctx, files, NOW);

        expect((await readdir(join(project.root, ".happy-uploads"))).sort()).toEqual([
            ".gitignore",
            "recent",
        ]);
        await expect(
            readFile(join(project.root, ".happy-uploads", ".gitignore"), "utf8"),
        ).resolves.toBe("*\n");
        await expect(readdir(join(bot.root, ".happy-uploads"))).resolves.toEqual([".gitignore"]);
        await expect(
            readFile(join(bot.root, ".happy-uploads", ".gitignore"), "utf8"),
        ).resolves.toBe("custom\n");
        // A folder no attachment ever reached does not get an uploads folder.
        await expect(readdir(plain.root)).resolves.toEqual([]);
    });

    it("stops between folders once the daemon is shutting down", async () => {
        const first = await folder("first");
        const second = await folder("second");
        await upload(first, "expired", 60 * DAY);
        await upload(second, "expired", 60 * DAY);
        vi.spyOn(files, "roots").mockResolvedValue([first, second]);
        let visited = 0;
        const remove = files.removeOlderThan.bind(files);
        vi.spyOn(files, "removeOlderThan").mockImplementation(async (...args) => {
            visited += 1;
            return await remove(...args);
        });

        await sweepHappyUploads(createRootContext(), files, NOW, () => visited > 0);

        expect(visited).toBe(1);
        await expect(readdir(join(second.root, ".happy-uploads"))).resolves.toEqual(["expired"]);
    });
});
