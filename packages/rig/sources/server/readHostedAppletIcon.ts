import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import { defaultAppletsRootDirectory } from "@slopus/happy-agent-features";

export type HostedAppletIconResult =
    | { contentType: string; data: Buffer; type: "file" }
    | { type: "not_found" };

/** Reads one feature-installed identity icon without exposing arbitrary applet-root paths. */
export async function readHostedAppletIcon(
    name: string,
    format: "ico" | "png",
): Promise<HostedAppletIconResult> {
    const root = join(defaultAppletsRootDirectory(), name);
    const target = join(root, format === "png" ? "favicon.png" : "favicon.ico");
    try {
        const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
        if (!realTarget.startsWith(realRoot + sep)) return { type: "not_found" };
        const facts = await stat(realTarget);
        if (!facts.isFile() || facts.size > 8 * 1024 * 1024) return { type: "not_found" };
        return {
            contentType: format === "png" ? "image/png" : "image/x-icon",
            data: await readFile(realTarget),
            type: "file",
        };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { type: "not_found" };
        throw error;
    }
}