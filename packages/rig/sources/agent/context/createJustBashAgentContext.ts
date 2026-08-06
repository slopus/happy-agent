import type { Bash } from "just-bash";

import type { AgentContext } from "./AgentContext.js";
import { createFileReadState } from "./FileReadState.js";
import { createJustBashBashContext } from "./createJustBashBashContext.js";
import { createJustBashFileSystemContext } from "./createJustBashFileSystemContext.js";
import { createPermissionContext } from "../../permissions/index.js";
import type { PermissionContext } from "../../permissions/index.js";

export function createJustBashAgentContext(
    bash: Bash,
    cwd: string,
    permissions: PermissionContext = createPermissionContext("full_access"),
): AgentContext {
    return {
        fs: createJustBashFileSystemContext(bash, cwd, permissions),
        bash: createJustBashBashContext(bash, cwd),
        fileReads: createFileReadState(),
        permissions,
    };
}
