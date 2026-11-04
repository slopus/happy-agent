import { computePermissions } from "@slopus/happy-agent-compute";
import { describe, expect, it } from "vitest";

import type { ChatMediaModule } from "../../sources/chatMedia/index.js";
import type { Compute, ComputeRunOptions } from "../../sources/compute/index.js";
import { videoPoster } from "../../sources/stories/tools/videoPoster.js";

const STILL = Buffer.from("a decoded first frame");

function machine(result: { stdout: string; exitCode: number | null; timedOut?: boolean }) {
    const commands: string[] = [];
    const compute = {
        shell: {
            run: async (options: ComputeRunOptions) => {
                commands.push(options.command);
                return { stderr: "", timedOut: false, ...result };
            },
        },
    } as unknown as Compute;
    return { compute, commands };
}

const chatMedia = {
    snapshot: async (bytes: Uint8Array, name: string) =>
        bytes.byteLength === STILL.byteLength
            ? { kind: "image", name, mimeType: "image/jpeg", size: bytes.byteLength, sha256: "d1" }
            : { kind: "file", name, mimeType: "image/jpeg", size: bytes.byteLength, sha256: "d2" },
} as unknown as ChatMediaModule;

describe("videoPoster", () => {
    const permissions = computePermissions("read_only");

    it("keeps the first frame ffmpeg decodes on the agent's machine as a still image", async () => {
        const { compute, commands } = machine({
            stdout: `${STILL.toString("base64")}\n`,
            exitCode: 0,
        });
        const poster = await videoPoster(compute, permissions, "/work/it's a clip.mp4", chatMedia);
        expect(poster).toEqual({
            kind: "image",
            name: "poster.jpg",
            mimeType: "image/jpeg",
            size: STILL.byteLength,
            sha256: "d1",
        });
        expect(commands[0]).toContain("ffmpeg -nostdin -v error -i '/work/it'\\''s a clip.mp4'");
        expect(commands[0]).toContain("-frames:v 1");
    });

    it("gives no poster when the machine cannot decode one", async () => {
        for (const result of [
            { stdout: "", exitCode: 0 },
            { stdout: STILL.toString("base64"), exitCode: 127 },
            { stdout: STILL.toString("base64"), exitCode: 0, timedOut: true },
            { stdout: Buffer.from("not a picture at all").toString("base64"), exitCode: 0 },
        ]) {
            const { compute } = machine(result);
            expect(await videoPoster(compute, permissions, "clip.mp4", chatMedia)).toBeUndefined();
        }
    });
});
