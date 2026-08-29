import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
    isUnsupportedDirectorySyncError,
    MAX_CODE_MODE_SNAPSHOT_BYTES,
    readCodeModeCheckpoint,
    writeCodeModeCheckpoint,
} from "../../sources/codeMode/engines/monty/MontyCheckpointStore.js";
import { temporaryTestConfig } from "../support/configModule.js";

describe("CodeModeCheckpointStore", () => {
    it("round-trips the bounded WAL envelope with private atomic filesystem state", async () => {
        const config = await temporaryTestConfig();
        const path = config.codeModeSnapshotPath("checkpoint01");
        await writeCodeModeCheckpoint(path, {
            records: [
                { callId: "checkpointcall01", result: { output: "result:\n42", isError: false } },
            ],
            snapshot: Uint8Array.from([1, 2, 3]),
            version: 1,
        });

        const restored = await readCodeModeCheckpoint(path);
        expect(restored).toMatchObject({
            records: [
                { callId: "checkpointcall01", result: { output: "result:\n42", isError: false } },
            ],
            version: 1,
        });
        expect(Array.from(restored?.snapshot ?? [])).toEqual([1, 2, 3]);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
        expect(await readdir(join(path, ".."))).toEqual(["snapshot.bin"]);
    });

    it("rejects oversized snapshots before creating a checkpoint", async () => {
        const config = await temporaryTestConfig();
        const path = config.codeModeSnapshotPath("checkpoint02");
        await expect(
            writeCodeModeCheckpoint(path, {
                records: [],
                snapshot: new Uint8Array(MAX_CODE_MODE_SNAPSHOT_BYTES + 1),
                version: 1,
            }),
        ).rejects.toThrow("invalid checkpoint");
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("releases resources after repeated write failures and still writes a later checkpoint", async () => {
        const config = await temporaryTestConfig();
        const blocker = join(config.configuration.paths.agentHome, "blocked");
        await mkdir(config.configuration.paths.agentHome, { recursive: true });
        await writeFile(blocker, "not a directory");
        const failed = await Promise.allSettled(
            Array.from(
                { length: 16 },
                async (_, index) =>
                    await writeCodeModeCheckpoint(join(blocker, String(index), "snapshot.bin"), {
                        records: [],
                        version: 1,
                    }),
            ),
        );
        expect(failed.every((result) => result.status === "rejected")).toBe(true);

        const recovered = config.codeModeSnapshotPath("checkpoint03");
        await expect(
            writeCodeModeCheckpoint(recovered, {
                records: [],
                version: 1,
            }),
        ).resolves.toBeUndefined();
        await expect(readCodeModeCheckpoint(recovered)).resolves.toMatchObject({ version: 1 });
    });

    it("ignores only explicit unsupported directory-sync errors", () => {
        expect(isUnsupportedDirectorySyncError(fileError("EINVAL"))).toBe(true);
        expect(isUnsupportedDirectorySyncError(fileError("ENOTSUP"))).toBe(true);
        expect(isUnsupportedDirectorySyncError(fileError("EIO"))).toBe(false);
        expect(isUnsupportedDirectorySyncError(fileError("ENOSPC"))).toBe(false);
    });
});

function fileError(code: string): Error {
    return Object.assign(new Error(code), { code });
}
