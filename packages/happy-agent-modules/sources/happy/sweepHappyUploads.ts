import type { Context } from "@steve.kite/stdlib";

import type { ProjectFilesModule } from "../files/index.js";
import { HAPPY_UPLOADS_DIRECTORY } from "./happyUploadPath.js";
import { ignoreHappyUploads } from "./ignoreHappyUploads.js";

/** How long a message's attachments stay after anything was last written to them, as in Happy CLI. */
export const HAPPY_UPLOADS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How often attachments past their retention are looked for after the first look at start. */
export const HAPPY_UPLOADS_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Removes, in every folder the files module serves, the attachments of each message that nothing
 * was written to for the retention period, and keeps every uploads folder that remains out of Git.
 * Folders are visited one at a time; one that fails, such as a folder on a runner that went away,
 * does not stop the others. `stopped` ends the walk early when the daemon shuts down.
 */
export async function sweepHappyUploads(
    ctx: Context,
    files: ProjectFilesModule,
    now: number,
    stopped: () => boolean = () => false,
): Promise<void> {
    for (const root of await files.roots(ctx)) {
        if (stopped()) return;
        try {
            const { found, removed } = await files.removeOlderThan(
                root,
                HAPPY_UPLOADS_DIRECTORY,
                now - HAPPY_UPLOADS_RETENTION_MS,
            );
            if (!found) continue;
            await ignoreHappyUploads(files, root);
            if (removed.length > 0) {
                ctx.log.debug("Removed attachments past their retention.", {
                    folders: removed.length,
                    root: root.root,
                });
            }
        } catch (error: unknown) {
            ctx.log.debug(
                "Attachments in one folder could not be checked.",
                { root: root.root },
                error,
            );
        }
    }
}
