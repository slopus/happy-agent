/**
 * Runs a script under the one Bun this repository builds with.
 *
 * The compiled agent embeds the runtime of whichever Bun compiled it, so the
 * Bun version is not a build detail — it is part of what ships. A developer
 * whose own Bun is older runs against a different runtime than production, and
 * the difference is invisible until something is missing from it: `Bun.Image`
 * arrived in 1.4.0, so on 1.3.9 every bot avatar looked broken locally while
 * the released binary was fine.
 *
 * The version lives in `.bun-version` at the repository root, which is also
 * what CI feeds to `setup-bun`, so there is one number rather than one per
 * place that needs it. A local Bun that already matches is used as it is; any
 * other is stood aside for a pinned `pnpm dlx`, which costs a download once.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pinned = readFileSync(join(repoRoot, ".bun-version"), "utf8").trim();

function localBunVersion() {
    try {
        return execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
    } catch {
        return undefined;
    }
}

const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("with-bun: nothing to run");
    process.exit(2);
}

const local = localBunVersion();
const [command, commandArgs] =
    local === pinned ? ["bun", args] : ["pnpm", ["dlx", `bun@${pinned}`, ...args]];

if (local !== pinned) {
    console.log(
        local === undefined
            ? `Bun ${pinned} is required and none is installed; fetching it for this run.`
            : `Bun ${pinned} is required and ${local} is installed; fetching ${pinned} for this run.`,
    );
    console.log(
        `Install it for good with: curl -fsSL https://bun.sh/install | bash -s bun-v${pinned}`,
    );
}

const result = spawnSync(command, commandArgs, { stdio: "inherit" });
if (result.error) {
    console.error(`with-bun: ${result.error.message}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
