import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const githubTokenSchema = Type.String({
    minLength: 1,
    maxLength: 16_384,
    pattern: "^[!-~]+(?![\\s\\S])",
});

/** Read an existing login only. Subprocess diagnostics may contain credentials; discard them. */
export async function discoverGithubCliToken(
    environment: Readonly<NodeJS.ProcessEnv>,
    home: string,
): Promise<string | undefined> {
    if (!isAbsolute(home)) return undefined;
    // Only installation directories from the machine PATH, never a repository's bin/gh.
    const trusted =
        process.platform === "win32"
            ? [join(environment.ProgramFiles ?? "C:\\Program Files", "GitHub CLI")]
            : [
                  join(home, ".local", "bin"),
                  "/opt/homebrew/bin",
                  "/usr/local/bin",
                  "/usr/bin",
                  "/bin",
              ];
    const paths = (environment.PATH ?? environment.Path ?? "")
        .split(delimiter)
        .slice(0, 32)
        .filter((path) => isAbsolute(path) && trusted.includes(resolve(path)));
    for (const path of paths) {
        const executable = join(path, process.platform === "win32" ? "gh.exe" : "gh");
        try {
            await access(executable, constants.X_OK);
        } catch {
            continue;
        }
        const env: NodeJS.ProcessEnv = {
            HOME: home,
            PATH: paths.join(delimiter),
            GH_PROMPT_DISABLED: "1",
            GH_NO_UPDATE_NOTIFIER: "1",
        };
        // Keep credential-store locations, not debug flags, tokens, Git config or runtime injection.
        for (const name of [
            "GH_CONFIG_DIR",
            "XDG_CONFIG_HOME",
            "APPDATA",
            "LOCALAPPDATA",
            "USERPROFILE",
            "SystemRoot",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
        ]) {
            if (environment[name] !== undefined) env[name] = environment[name];
        }
        return await new Promise<string | undefined>((resolveToken) => {
            execFile(
                executable,
                ["auth", "token", "--hostname", "github.com"],
                {
                    cwd: home,
                    env,
                    encoding: "utf8",
                    timeout: 3_000,
                    killSignal: "SIGKILL",
                    maxBuffer: 16_386,
                    windowsHide: true,
                },
                (error, stdout) => {
                    const token = stdout.replace(/\r?\n$/u, "");
                    resolveToken(
                        error === null && Value.Check(githubTokenSchema, token) ? token : undefined,
                    );
                },
            );
        }).catch(() => undefined);
    }
    return undefined;
}
