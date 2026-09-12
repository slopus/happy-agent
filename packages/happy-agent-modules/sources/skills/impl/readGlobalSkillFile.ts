import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { buffer } from "node:stream/consumers";
import { skillRelativePathSchema } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { GlobalSkillsError } from "../GlobalSkillsError.js";

export function withinSkill(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resolve, open without following a final link, then verify the opened inode against live containment. */
export async function readGlobalSkillFile(
    root: string,
    path: string,
    maxBytes: number,
): Promise<Buffer> {
    if (!Value.Check(skillRelativePathSchema, path))
        throw new GlobalSkillsError(
            400,
            "invalid_request",
            "Provide a relative file path inside the skill.",
        );
    const candidate = join(root, path);
    try {
        const canonical = await realpath(candidate);
        if (!withinSkill(root, canonical))
            throw new GlobalSkillsError(403, "forbidden", "The file is outside this skill.");
        const handle = await open(
            canonical,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            const info = await handle.stat();
            if (!info.isFile())
                throw new GlobalSkillsError(
                    400,
                    "invalid_request",
                    "Only regular skill files may be read.",
                );
            const current = await realpath(candidate);
            const live = await stat(current);
            if (
                !withinSkill(root, current) ||
                current !== canonical ||
                info.dev !== live.dev ||
                info.ino !== live.ino
            )
                throw new GlobalSkillsError(
                    403,
                    "forbidden",
                    "The skill file location changed while it was opened.",
                );
            if (info.size > maxBytes)
                throw new GlobalSkillsError(
                    413,
                    "too_large",
                    "The skill file is too large to read.",
                );
            const bytes = await buffer(
                handle.createReadStream({ autoClose: false, end: maxBytes }),
            );
            if (bytes.byteLength > maxBytes)
                throw new GlobalSkillsError(
                    413,
                    "too_large",
                    "The skill file is too large to read.",
                );
            return bytes;
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error instanceof GlobalSkillsError) throw error;
        // Keep host paths and operating-system diagnostics out of management responses.
        const { code } = error as NodeJS.ErrnoException;
        if (code === "ENOENT" || code === "ENOTDIR")
            throw new GlobalSkillsError(404, "not_found", "The skill file no longer exists.");
        throw new GlobalSkillsError(403, "forbidden", "The skill file cannot be read.");
    }
}
