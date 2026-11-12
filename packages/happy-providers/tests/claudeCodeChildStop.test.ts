import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    afterClaudeCodeRenewal,
    spawnClaudeCodeChild,
    type ClaudeCodeChildSettings,
} from "@/vendors/claude/impl/spawnClaudeCodeChild.js";

// A Claude Code child renewing a stored sign-in holds `.oauth_refresh.lock` in the sign-in's
// storage directory. Stopping it then would spend the refresh token without saving its successor.
describe.skipIf(process.platform === "win32")(
    "stopping a Claude Code child that renews a stored sign-in",
    () => {
        const cleanups: (() => Promise<void>)[] = [];

        afterEach(async () => {
            for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
        });

        async function start(settings: ClaudeCodeChildSettings = {}) {
            const storage = await mkdtemp(join(tmpdir(), "claude-child-stop-"));
            cleanups.push(async () => await rm(storage, { recursive: true, force: true }));
            const child = spawnClaudeCodeChild(
                {
                    command: process.execPath,
                    args: ["-e", "setInterval(() => {}, 1000)"],
                    env: { PATH: process.env.PATH, CLAUDE_SECURESTORAGE_CONFIG_DIR: storage },
                    signal: new AbortController().signal,
                },
                { lockPollMs: 20, ...settings },
            );
            cleanups.push(async () => {
                if (child.exitCode === null && child.signalCode === null) {
                    process.kill(child.pid!, "SIGKILL");
                }
            });
            const exit = new Promise<{ signal: NodeJS.Signals | null; at: number }>((resolve) => {
                child.once("exit", (_, signal) => resolve({ signal, at: Date.now() }));
            });
            const lock = join(storage, ".oauth_refresh.lock");
            // Claude Code names the lock's holder just after taking it.
            const holdLock = async (pid: number | undefined) => {
                await mkdir(lock);
                const { birthtimeMs } = await lstat(lock);
                await writeFile(
                    join(storage, ".oauth_refresh.lock.owner"),
                    JSON.stringify({ pid, lockBirthtimeMs: birthtimeMs, pidDomain: "darwin" }),
                );
            };
            return { child, exit, lock, holdLock };
        }

        it("stops at once when no renewal is in progress", async () => {
            const { child, exit } = await start();
            const requested = Date.now();
            expect(child.kill("SIGTERM")).toBe(true);
            const stopped = await exit;
            expect(stopped.signal).toBe("SIGTERM");
            expect(stopped.at - requested).toBeLessThan(1_000);
        });

        it("waits for a renewal this child holds and then stops", async () => {
            const { child, exit, lock, holdLock } = await start();
            await holdLock(child.pid);
            child.kill("SIGTERM");
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(child.exitCode).toBeNull();
            expect(child.signalCode).toBeNull();

            const released = Date.now();
            await rm(lock, { recursive: true });
            const stopped = await exit;
            expect(stopped.signal).toBe("SIGTERM");
            expect(stopped.at).toBeGreaterThanOrEqual(released);
        });

        it("waits while the lock's holder is not yet named", async () => {
            const { child, lock } = await start();
            await mkdir(lock);
            child.kill("SIGTERM");
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(child.signalCode).toBeNull();
        });

        it("does not wait for a renewal another process holds", async () => {
            const { child, exit, holdLock } = await start();
            await holdLock(process.pid);
            const requested = Date.now();
            child.kill("SIGTERM");
            const stopped = await exit;
            expect(stopped.signal).toBe("SIGTERM");
            expect(stopped.at - requested).toBeLessThan(1_000);
        });

        it("delivers the strongest stop requested while it waited", async () => {
            const { child, exit, lock } = await start();
            await mkdir(lock);
            child.kill("SIGTERM");
            child.kill("SIGKILL");
            child.kill("SIGTERM");
            await rm(lock, { recursive: true });
            expect((await exit).signal).toBe("SIGKILL");
        });

        it("ignores a lock not touched within the wait", async () => {
            const { child, exit, lock } = await start();
            await mkdir(lock);
            const abandoned = new Date(Date.now() - 11_000);
            await utimes(lock, abandoned, abandoned);
            const requested = Date.now();
            child.kill("SIGTERM");
            const stopped = await exit;
            expect(stopped.signal).toBe("SIGTERM");
            expect(stopped.at - requested).toBeLessThan(1_000);
        });

        it("stops anyway once the wait runs out", async () => {
            const { child, exit, lock } = await start({ stopWaitMs: 300 });
            await mkdir(lock);
            const requested = Date.now();
            child.kill("SIGTERM");
            const stopped = await exit;
            expect(stopped.signal).toBe("SIGTERM");
            expect(stopped.at - requested).toBeGreaterThanOrEqual(250);
            expect(stopped.at - requested).toBeLessThan(1_000);
        });

        it("shares one wait between every stop of a child", async () => {
            const { child, exit, lock } = await start({ stopWaitMs: 600 });
            await mkdir(lock);
            const requested = Date.now();
            let groupStopAt = 0;
            // The harness stops a whole process tree this way, then the SDK stops the child.
            afterClaudeCodeRenewal(child, () => {
                groupStopAt = Date.now();
            });
            await new Promise((resolve) => setTimeout(resolve, 300));
            child.kill("SIGTERM");
            const stopped = await exit;
            expect(groupStopAt - requested).toBeGreaterThanOrEqual(500);
            expect(stopped.at - requested).toBeLessThan(1_200);
        });
    },
);
