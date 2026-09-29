import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("source and compiled launchers restart once with safe JIT settings and preserve their arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "happy-safe-bun-"));
    const entry = join(directory, "entry.ts");
    const binary = join(directory, process.platform === "win32" ? "probe.exe" : "probe");
    try {
        await writeFile(
            entry,
            `import { ensureSafeBunRuntime } from ${JSON.stringify(fileURLToPath(new URL("../../sources/lifecycle/ensureSafeBunRuntime.ts", import.meta.url)))};
import { numberOfDFGCompiles, noInline } from "bun:jsc";
console.log("entry", process.pid);
await ensureSafeBunRuntime();
function hot(value) { return value + 1; }
noInline(hot);
let value = 0;
for (let index = 0; index < 1000000; index++) value = hot(value);
console.log(JSON.stringify({ args: process.argv.slice(2), dfg: process.env.BUN_JSC_useDFGJIT, ftl: process.env.BUN_JSC_useFTLJIT, compiles: numberOfDFGCompiles(hot), value }));
process.exit(7);
`,
        );
        const result = await Bun.build({
            entrypoints: [entry],
            compile: { outfile: binary },
            define: { HAPPY_AGENT_STANDALONE: "true" },
        });
        expect(result.success).toBe(true);
        for (const command of [[process.execPath, entry], [binary]]) {
            const child = spawnSync(command[0], [...command.slice(1), "run", "with spaces"], {
                env: { ...process.env, BUN_JSC_useDFGJIT: "true", BUN_JSC_useFTLJIT: "true" },
                encoding: "utf8",
                timeout: 20_000,
            });
            expect(child.error).toBeUndefined();
            expect(child.signal).toBeNull();
            expect(child.status).toBe(7);
            const lines = child.stdout.trim().split("\n");
            expect(lines).toHaveLength(3);
            if (process.platform !== "win32") expect(lines[0]).toBe(lines[1]);
            expect(JSON.parse(lines[2])).toEqual({
                args: ["run", "with spaces"],
                dfg: "false",
                ftl: "false",
                // JavaScriptCore's TestRunnerUtils returns this sentinel when
                // the DFG is disabled and the function has baseline bytecode.
                compiles: 1000000,
                value: 1000000,
            });
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 60_000);
