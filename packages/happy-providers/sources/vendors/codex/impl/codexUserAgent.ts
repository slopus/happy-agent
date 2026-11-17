import { execFileHidden } from "@/core/hiddenChildProcess.js";
import { arch, platform, release, type } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFileHidden);
let cached: Promise<string> | undefined;

export function resolveCodexUserAgent(): Promise<string> {
    return (cached ??= createCodexUserAgent());
}

export function formatCodexUserAgent(options: {
    architecture: string;
    osType: string;
    osVersion: string;
    terminal: string;
    version: string;
}): string {
    const prefix = `codex_exec/${options.version} (${options.osType} ${options.osVersion}; ${options.architecture}) ${options.terminal}`;
    return sanitize(`${prefix} (codex_exec; ${options.version})`, prefix);
}

async function createCodexUserAgent(): Promise<string> {
    const [version, os] = await Promise.all([readCodexVersion(), readOperatingSystem()]);
    return formatCodexUserAgent({
        architecture: normalizeArchitecture(arch()),
        osType: os.osType,
        osVersion: os.osVersion,
        terminal: terminalToken(process.env),
        version,
    });
}

async function readCodexVersion(): Promise<string> {
    try {
        const { stdout } = await run("codex", ["--version"], { timeout: 5_000 });
        return stdout.trim().replace(/^codex-cli\s+/u, "") || "unknown";
    } catch {
        return "unknown";
    }
}

async function readOperatingSystem(): Promise<{ osType: string; osVersion: string }> {
    if (platform() === "darwin") {
        try {
            const { stdout } = await run("sw_vers", ["-productVersion"], { timeout: 5_000 });
            return { osType: "Mac OS", osVersion: stdout.trim() || release() };
        } catch {
            return { osType: "Mac OS", osVersion: release() };
        }
    }
    return { osType: type(), osVersion: release() };
}

function normalizeArchitecture(value: string): string {
    return value === "x64" ? "x86_64" : value;
}

function terminalToken(env: NodeJS.ProcessEnv): string {
    const program = env.TERM_PROGRAM?.trim();
    const version = env.TERM_PROGRAM_VERSION?.trim();
    if (program) return version ? `${program}/${version}` : program;
    return env.TERM?.trim() || "unknown";
}

function sanitize(candidate: string, fallback: string): string {
    const sanitized = candidate.replace(/[^\x20-\x7e]/gu, "_");
    return sanitized.length > 0 ? sanitized : fallback;
}
