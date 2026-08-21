import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("installation inspection reports daemon health", () => {
    it("answers happy-terminal inspect --json through the daemon API and exits cleanly", async () => {
        const repositoryRoot = resolve(import.meta.dirname, "../../..");
        const sourceHook = join(
            repositoryRoot,
            "packages/gym/sources/registerTypeScriptSourceHooks.mjs",
        );
        const rigMain = join(repositoryRoot, "packages/happy-terminal/sources/main.ts");
        const tsxEntry = pathToFileURL(
            createRequire(join(repositoryRoot, "package.json")).resolve("tsx"),
        ).href;
        const wrapper = `
import { spawn } from "node:child_process";

const inspectionArguments = ${JSON.stringify(["--import", tsxEntry, "--import", sourceHook, rigMain, "inspect", "--json"])};

async function runInspection() {
    const child = spawn(process.execPath, inspectionArguments, {
        env: process.env,
        stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    const result = await new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    return { child, payload: JSON.parse(stdout.trim()), result };
}

function processSurvived(child) {
    if (child.pid === undefined) return false;
    try {
        process.kill(child.pid, 0);
        return true;
    } catch (error) {
        if (error?.code !== "ESRCH") throw error;
        return false;
    }
}

const first = await runInspection();
const second = await runInspection();
const proof = {
    exitCode: first.result.code,
    signal: first.result.signal,
    formatVersion: first.payload.formatVersion,
    source: first.payload.source,
    cliVersionIsString: typeof first.payload.cliVersion === "string",
    daemonVersionIsString: typeof first.payload.health?.version?.daemon === "string",
    protocolIsInteger: Number.isInteger(first.payload.health?.version?.protocol),
    ready: first.payload.health?.ready,
    orphanProcess: processSurvived(first.child),
    repeatExitCode: second.result.code,
    repeatReady: second.payload.health?.ready,
    repeatOrphanProcess: processSurvived(second.child),
};
console.log("INSPECTION_PROOF " + JSON.stringify(proof));
for (const [name, value] of Object.entries(proof)) {
    console.log("PROOF " + name + "=" + JSON.stringify(value));
}
setInterval(() => {}, 60_000);
`;
        const gym = await createGym({
            entrypoint: [process.execPath, "run-inspection.mjs"],
            files: { "run-inspection.mjs": wrapper },
            startupText: "INSPECTION_PROOF",
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("PROOF exitCode=0");
        expect(screen.text).toContain("PROOF signal=null");
        expect(screen.text).toContain("PROOF formatVersion=2");
        expect(screen.text).toContain('PROOF source="cli"');
        expect(screen.text).toContain("PROOF cliVersionIsString=true");
        expect(screen.text).toContain("PROOF daemonVersionIsString=true");
        expect(screen.text).toContain("PROOF protocolIsInteger=true");
        expect(screen.text).toContain("PROOF ready=true");
        expect(screen.text).toContain("PROOF orphanProcess=false");
        expect(screen.text).toContain("PROOF repeatExitCode=0");
        expect(screen.text).toContain("PROOF repeatReady=true");
        expect(screen.text).toContain("PROOF repeatOrphanProcess=false");
    });
});
