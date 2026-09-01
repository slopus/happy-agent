import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Prepare the single-user local API credential, or remove it for a team deployment. */
export async function prepareLocalApiToken(
    path: string,
    teamModeEnabled: boolean,
): Promise<string | undefined> {
    if (teamModeEnabled) {
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        });
        return undefined;
    }

    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
    if (existing !== undefined) {
        const token = existing.trim();
        if (!TOKEN_PATTERN.test(token)) {
            throw new Error("The Happy Agent API token is invalid.");
        }
        await chmod(path, 0o600);
        return token;
    }
    const token = randomBytes(32).toString("base64url");
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${token}\n`, { flag: "wx", mode: 0o600 });
    try {
        await rename(temporary, path);
    } catch (error) {
        const raced = await readFile(path, "utf8").catch(() => undefined);
        if (raced === undefined) throw error;
        const value = raced.trim();
        if (!TOKEN_PATTERN.test(value)) throw error;
        return value;
    }
    await chmod(path, 0o600);
    return token;
}
