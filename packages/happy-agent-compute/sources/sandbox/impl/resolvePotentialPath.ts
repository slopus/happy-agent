import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";

export async function resolvePotentialPath(target: string, symlinkDepth = 0): Promise<string> {
    if (symlinkDepth > 40) throw new Error(`Cannot resolve symbolic link chain for ${target}.`);

    const pathRoot = parse(target).root;
    const parts = target.slice(pathRoot.length).split(sep).filter(Boolean);
    let current = pathRoot;
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part === undefined) continue;
        const candidate = join(current, part);
        try {
            const metadata = await lstat(candidate);
            if (metadata.isSymbolicLink()) {
                const destination = resolve(dirname(candidate), await readlink(candidate));
                return resolvePotentialPath(
                    join(destination, ...parts.slice(index + 1)),
                    symlinkDepth + 1,
                );
            }
            current = candidate;
        } catch (error) {
            if (
                error instanceof Error &&
                "code" in error &&
                (error as NodeJS.ErrnoException).code === "ENOENT"
            ) {
                // Windows may spell existing ancestors using DOS 8.3 names or
                // different casing. Resolve that parent before appending names
                // that do not exist yet, so file and shell policies agree.
                return join(
                    process.platform === "win32" ? await realpath(current) : current,
                    ...parts.slice(index),
                );
            }
            throw error;
        }
    }
    return process.platform === "win32" ? realpath(current) : current;
}
