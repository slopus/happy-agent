import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSocketPeer } from "../../sources/lifecycle/readSocketPeer.ts";
import {
    describeLocalProcess,
    isHappyAgentProcess,
} from "../../sources/lifecycle/describeLocalProcess.ts";

// The kernel's peer credentials are read through Bun's FFI, so only the Bun runtime the agent
// ships on can prove them: LOCAL_PEERPID and getpeereid on macOS, SO_PEERCRED on Linux.
test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "names the process and user listening on a Unix socket",
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "peer-"));
        const socketPath = join(directory, "s.sock");
        const listener = spawn(
            "node",
            [
                "-e",
                `require("node:net").createServer((s) => s.end()).listen(${JSON.stringify(socketPath)}, () => console.log("listening"))`,
            ],
            { stdio: ["ignore", "pipe", "inherit"] },
        );
        try {
            await new Promise((resolve) => listener.stdout.once("data", resolve));

            expect(await readSocketPeer(socketPath)).toEqual({
                pid: listener.pid,
                uid: process.getuid(),
            });
            const described = await describeLocalProcess(listener.pid);
            expect(described).toMatchObject({ parentPid: process.pid, uid: process.getuid() });
            expect(described.executable).toMatch(/[\\/]node$/);
            expect(described.commandLine).toContain("createServer");
            expect(isHappyAgentProcess(described)).toBe(false);
            expect(await readSocketPeer(join(directory, "missing.sock"))).toBeUndefined();
        } finally {
            listener.kill("SIGKILL");
            await rm(directory, { force: true, recursive: true });
        }
    },
);
