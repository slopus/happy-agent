import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";
import { computePermissions } from "../../sources/ComputePermissions.js";
import { createHostCompute } from "../../sources/host/createHostCompute.js";

const enabled = process.env.HAPPY_AGENT_COMPUTE_WINDOWS_LIVE_TEST === "1";
describe.runIf(enabled)("native Windows compute SDK boundary", () => {
    it("enforces file permissions through the installed supervisor and restores restrictions", async () => {
        if (process.platform !== "win32") throw new Error("Windows live checks require Windows.");
        const ctx = createRootContext().named("windows-compute-release");
        // Exercise normal per-user Windows storage. Broad Everyone-write ACLs
        // are outside the inherited Codex token model's write boundary.
        const root = await mkdtemp(join(tmpdir(), "happy-windows-live-"));
        const cwd = join(root, "project");
        await mkdir(cwd);
        const shortCwd = execFileSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(
                    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${cwd.replaceAll("'", "''")}').ShortPath`,
                    "utf16le",
                ).toString("base64"),
            ],
            { encoding: "utf8", windowsHide: true },
        ).trim();
        const compute = createHostCompute({ ctx, cwd: shortCwd });
        const outside = join(root, "outside.txt");
        const proof = join(cwd, "proof.txt");
        try {
            const run = (command: string, mode: "read_only" | "workspace_write" | "full_access") =>
                compute.shell.run({
                    command,
                    permissions: computePermissions(mode),
                    timeoutMs: 30_000,
                });
            const allowed = await run(
                "Set-Content -LiteralPath proof.txt -Value inside -ErrorAction Stop",
                "workspace_write",
            );
            expect(allowed, JSON.stringify(allowed)).toMatchObject({
                exitCode: 0,
                timedOut: false,
            });
            expect((await readFile(proof, "utf8")).trim()).toBe("inside");
            for (const mode of ["workspace_write", "full_access"] as const) {
                const acl = await run(
                    "$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath proof.txt).Owner",
                    mode,
                );
                expect(acl, JSON.stringify(acl)).toMatchObject({ exitCode: 0, timedOut: false });
                expect(acl.stdout.trim().length).toBeGreaterThan(0);
            }
            const readOnly = await run(
                "Set-Content -LiteralPath proof.txt -Value forbidden -ErrorAction Stop",
                "read_only",
            );
            expect(readOnly.exitCode).not.toBe(0);
            expect((await readFile(proof, "utf8")).trim()).toBe("inside");
            const command = `Set-Content -LiteralPath ${quote(outside)} -Value outside -ErrorAction Stop`;
            const denied = await run(command, "workspace_write");
            expect(denied.exitCode).not.toBe(0);
            expect(existsSync(outside)).toBe(false);
            const elevated = await run(command, "full_access");
            expect(elevated.exitCode).toBe(0);
            expect((await readFile(outside, "utf8")).trim()).toBe("outside");
            const restrictedAgain = await run(command, "workspace_write");
            expect(restrictedAgain.exitCode).not.toBe(0);
            const secret = join(cwd, "private.txt");
            await writeFile(secret, "private-release-fixture");
            const privateRead = await compute.shell.run({
                command: "Get-Content -LiteralPath private.txt -ErrorAction Stop",
                permissions: computePermissions("workspace_write", { deniedReadPaths: [secret] }),
                timeoutMs: 30_000,
            });
            expect(privateRead.exitCode).not.toBe(0);
            expect(privateRead.stdout).not.toContain("private-release-fixture");
        } finally {
            await compute.dispose(ctx);
            await rm(root, { recursive: true, force: true });
        }
    }, 180_000);

    it("blocks network access by default and permits an explicit Windows online policy", async () => {
        if (process.platform !== "win32") throw new Error("Windows live checks require Windows.");
        const ctx = createRootContext().named("windows-compute-network-release");
        const cwd = await mkdtemp(join(tmpdir(), "happy-windows-network-"));
        const compute = createHostCompute({ ctx, cwd });
        const server = createServer((socket) => socket.end("happy-network-proof"));
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test listener");
        const script = `const s=require('net').connect(${address.port},'127.0.0.1');s.on('data',b=>process.stdout.write(b));s.on('error',()=>process.exit(17));s.setTimeout(3000,()=>process.exit(18));`;
        const command = `& ${quote(process.execPath)} -e ${quote(script)}; exit $LASTEXITCODE`;
        try {
            for (const egress of [true, false, true]) {
                const result = await compute.shell.run({
                    command,
                    permissions: computePermissions("workspace_write", {
                        allowedReadPaths: [process.execPath],
                        network: { egress, localBinding: egress },
                    }),
                    timeoutMs: 30_000,
                });
                expect(result.timedOut).toBe(false);
                if (egress) {
                    expect(result, JSON.stringify(result)).toMatchObject({
                        exitCode: 0,
                        stdout: "happy-network-proof",
                    });
                } else {
                    expect(result.exitCode).not.toBe(0);
                    expect(result.stdout).not.toContain("happy-network-proof");
                }
            }
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await compute.dispose(ctx);
            await rm(cwd, { recursive: true, force: true });
        }
    }, 120_000);
});

function quote(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}
