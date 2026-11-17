import { execFileHidden } from "../utils/hiddenChildProcess.js";
import { promisify } from "node:util";

const execFile = promisify(execFileHidden);
let cached: Promise<string> | undefined;

export function resolveGitExecutable(): Promise<string> {
    cached ??= resolveExecutable();
    return cached;
}

export function resetResolvedGitExecutable(): void {
    cached = undefined;
}

async function resolveExecutable(): Promise<string> {
    if (process.platform === "darwin") {
        try {
            const result = await execFile("xcrun", ["--find", "git"], {
                encoding: "utf8",
                timeout: 5_000,
            });
            const path = result.stdout.trim();
            if (path.length > 0) return path;
        } catch {
            // PATH lookup is the normal fallback when Xcode command line tools are unavailable.
        }
    }
    return "git";
}
