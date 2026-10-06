import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveWorkspacePath } from "./resolveWorkspacePath.js";
import type { GymFixture } from "./types.js";

export async function createFixtureWorkspace(
    files: Readonly<Record<string, GymFixture>> = {},
    directory?: string,
): Promise<string> {
    const target = resolve(directory ?? (await mkdtemp(join(tmpdir(), "happy-terminal-gym-"))));
    try {
        await mkdir(target, { recursive: true });
        await chmod(target, 0o777);
        for (const [path, content] of Object.entries(files)) {
            const destination = resolveWorkspacePath(target, path);
            await mkdir(dirname(destination), { recursive: true });
            // Docker's unprivileged user may have a different UID from the host runner. These
            // isolated fixture directories must permit creating siblings as well as reading seeds.
            for (let parent = dirname(destination); parent !== target; parent = dirname(parent)) {
                await chmod(parent, 0o777);
            }
            const fixture =
                typeof content === "string" || content instanceof Uint8Array
                    ? { content }
                    : content;
            await writeFile(destination, fixture.content);
            await chmod(destination, fixture.mode ?? 0o666);
        }
        return target;
    } catch (error) {
        await rm(target, { force: true, recursive: true });
        throw error;
    }
}
