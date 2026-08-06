import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import type { PermissionMode } from "../../permissions/index.js";
import { createSensitiveReadPaths } from "./createSensitiveReadPaths.js";
import { createUserSkillRootPaths } from "./createUserSkillRootPaths.js";
import { findExecutableSearchPaths } from "./findExecutableSearchPaths.js";
import { findGitWritablePaths } from "./findGitWritablePaths.js";
import { resolvePotentialPath } from "./resolvePotentialPath.js";
import { getBuiltinSkillRoot } from "../skills/getBuiltinSkillRoot.js";

export async function createSandboxFilesystemConfig(options: {
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    mode: PermissionMode;
    protectedPaths?: readonly string[];
    sandboxConfigDirectory?: string;
    temporaryDirectory?: string;
    uid?: number;
}) {
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const temporaryDirectory = options.temporaryDirectory ?? tmpdir();
    const writablePaths = [temporaryDirectory];
    if (options.mode === "workspace_write" || options.mode === "auto") {
        writablePaths.push(options.cwd);
        writablePaths.push(...(await findGitWritablePaths(options.cwd)));
    }

    const controlDirectory = join(
        temporaryDirectory,
        `rig-${options.uid ?? process.getuid?.() ?? 0}`,
    );
    const denyRead = createSensitiveReadPaths({
        additionalPaths: [options.sandboxConfigDirectory],
        environment,
        homeDirectory,
        temporaryDirectory,
        ...(options.uid === undefined ? {} : { uid: options.uid }),
    });
    const denyWrite = [
        controlDirectory,
        environment.RIG_SERVER_DIRECTORY,
        environment.RIG_SERVER_SOCKET_PATH,
        environment.RIG_SERVER_TOKEN_PATH,
        options.sandboxConfigDirectory,
        ...(options.protectedPaths ?? []),
    ].filter(
        (path, index, paths): path is string =>
            typeof path === "string" && path.length > 0 && paths.indexOf(path) === index,
    );
    const canonicalHomeDirectory = await resolvePotentialPath(homeDirectory);
    const executableSearchPaths =
        process.platform === "win32"
            ? []
            : await findExecutableSearchPaths({
                  cwd: options.cwd,
                  environment,
                  homeDirectory,
                  temporaryDirectory,
              });
    const readableHomeToolPaths = executableSearchPaths.filter((path) =>
        path.startsWith(`${canonicalHomeDirectory}${sep}`),
    );

    return {
        denyRead,
        allowRead: [
            options.cwd,
            getBuiltinSkillRoot(),
            ...createUserSkillRootPaths(homeDirectory),
            ...readableHomeToolPaths,
        ],
        allowWrite: writablePaths,
        denyWrite,
    };
}
