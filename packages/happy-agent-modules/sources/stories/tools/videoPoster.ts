import { quoteShellArgument, type ComputePermissions } from "@slopus/happy-agent-compute";

import type { ChatMediaModule } from "../../chatMedia/index.js";
import type { Compute } from "../../compute/index.js";
import type { StoryRecord } from "../storyStore.js";

/**
 * A still of a video's first frame, taken with the agent machine's own ffmpeg as the story is
 * posted, so a reply can quote it after the story ends. Without ffmpeg there is none.
 */
export async function videoPoster(
    compute: Compute,
    permissions: ComputePermissions,
    path: string,
    chatMedia: ChatMediaModule,
): Promise<StoryRecord["media"] | undefined> {
    // The shell's output is text, so the frame crosses it as Base64.
    const frame = `-frames:v 1 -vf scale=540:-2 -f image2pipe -c:v mjpeg -q:v 3 -`;
    const command = `ffmpeg -nostdin -v error -i ${quoteShellArgument(path)} ${frame} | base64`;
    const run = { command, permissions, timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024 };
    const result = await compute.shell.run(run).catch(() => undefined);
    if (result?.exitCode !== 0 || result.timedOut || result.stdoutOmittedBytes) return undefined;
    const bytes = Buffer.from(result.stdout, "base64");
    const item = bytes.byteLength > 0 && (await chatMedia.snapshot(bytes, "poster.jpg"));
    if (!item || item.kind !== "image") return undefined;
    const { kind, name, mimeType, size, sha256, thumbhash } = item;
    return { kind, name, mimeType, size, sha256, thumbhash };
}
