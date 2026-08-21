import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolveWorkspacePath } from "./resolveWorkspacePath.js";
import type { GymFixture } from "./types.js";

export async function createFixtureWorkspace(
    files: Readonly<Record<string, GymFixture>> = {},
    directory?: string,
): Promise<string> {
    const target = directory ?? (await mkdtemp(join(tmpdir(), "happy-terminal-gym-")));
    try {
        await mkdir(target, { recursive: true });
        await chmod(target, 0o777);
        for (const [path, content] of Object.entries(files)) {
            const destination = resolveWorkspacePath(target, path);
            await mkdir(dirname(destination), { recursive: true });
            const fixture =
                typeof content === "string" || content instanceof Uint8Array
                    ? { content }
                    : content;
            await writeFile(destination, fixture.content);
            if (fixture.mode !== undefined) await chmod(destination, fixture.mode);
        }
        return target;
    } catch (error) {
        await rm(target, { force: true, recursive: true });
        throw error;
    }
}
