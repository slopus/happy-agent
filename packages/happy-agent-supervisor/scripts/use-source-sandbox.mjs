// Disposable CI only. Replaces the published supervisor and compute that the Agent modules load
// with this checkout's builds, so an unreleased sandbox change is proven on the Agent's own path.
//
//   node use-source-sandbox.mjs supervisor <native binary>   before building compute
//   node use-source-sandbox.mjs compute                      after building compute
import { cp, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("This replaces installed packages and runs only on hosted CI.");
}
const repository = resolve(import.meta.dirname, "../../..");
const compute = await realpath(
    join(repository, "packages/happy-agent-modules/node_modules/@slopus/happy-agent-compute"),
);
const supervisor = join(dirname(compute), "happy-agent-supervisor");

async function replace(installed, built) {
    // Removing first gives the copy new inodes, so a store hardlink is never written through.
    await rm(installed, { force: true, recursive: true });
    await cp(built, installed, { recursive: true });
    console.log(`${installed} <- ${built}`);
}

const [step, binary] = process.argv.slice(2);
if (step === "supervisor") {
    if (binary === undefined) throw new Error("Pass the native supervisor binary.");
    const { resolveSupervisorBinary } = await import(
        pathToFileURL(join(supervisor, "dist/index.js")).href
    );
    const installedBinary = await realpath(resolveSupervisorBinary());
    await replace(
        join(supervisor, "dist"),
        join(repository, "packages/happy-agent-supervisor/dist"),
    );
    await replace(installedBinary, resolve(binary));
} else if (step === "compute") {
    await replace(join(compute, "dist"), join(repository, "packages/happy-agent-compute/dist"));
} else {
    throw new Error("Pass supervisor or compute.");
}
