import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { ProviderCliInstallation } from "../ProviderCli.js";
import type {
    ProviderCliCandidate,
    ProviderCliDefinition,
    ProviderCliMachine,
} from "./providerCliCatalog.js";
import { runProviderCliCommand } from "./runProviderCliCommand.js";

const CHECK_TIMEOUT_MS = 10_000;
const MISSING: ProviderCliInstallation = {
    status: "missing",
    path: null,
    version: null,
    source: null,
    desktopApp: null,
};

/**
 * Find the program the daemon would use: the most specific known location first — the vendor's
 * own installer, then the vendor's desktop application, then a package manager — and anything
 * else on `PATH` last. The program reports its own version.
 */
export async function discoverProviderCli(
    definition: ProviderCliDefinition,
    machine: ProviderCliMachine,
): Promise<ProviderCliInstallation> {
    const known = definition.candidates(machine);
    const found = known.find((candidate) => isExecutable(candidate.path, machine.platform));
    const candidate = found ?? onPath(definition.program, machine, known);
    if (candidate === undefined) return MISSING;
    const result = await runProviderCliCommand(
        candidate.path,
        ["--version"],
        machine.env,
        CHECK_TIMEOUT_MS,
    );
    const version = /\d+\.\d+\.\d+[\w.+-]*/.exec(`${result.stdout}\n${result.stderr}`)?.[0];
    return {
        status: "installed",
        path: candidate.path,
        version: result.code === 0 && version !== undefined ? version : null,
        source: candidate.source,
        desktopApp: candidate.desktopApp ?? null,
    };
}

function onPath(
    program: string,
    machine: ProviderCliMachine,
    known: readonly ProviderCliCandidate[],
): ProviderCliCandidate | undefined {
    const names = machine.platform === "win32" ? [`${program}.exe`, `${program}.cmd`] : [program];
    for (const directory of (machine.env["PATH"] ?? "").split(delimiter)) {
        if (directory.length === 0) continue;
        for (const name of names) {
            const path = join(directory, name);
            if (!isExecutable(path, machine.platform)) continue;
            // A link such as `~/.local/bin/grok` names a known installation elsewhere.
            const real = realpath(path);
            const match = known.find((candidate) => realpath(candidate.path) === real);
            return match === undefined ? { path, source: "other" } : { ...match, path };
        }
    }
    return undefined;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
    try {
        if (!statSync(path).isFile()) return false;
        if (platform !== "win32") accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function realpath(path: string): string | undefined {
    try {
        return realpathSync(path);
    } catch {
        return undefined;
    }
}
