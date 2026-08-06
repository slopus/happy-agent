import { resolve } from "node:path";

import { PROJECT_PROTECTED_FILE_NAMES } from "../../config/projectProtectedFileNames.js";

export function isProtectedProjectConfigPath(cwd: string, targetPath: string): boolean {
    const requestedPath = resolve(targetPath);
    return PROJECT_PROTECTED_FILE_NAMES.some((name) => requestedPath === resolve(cwd, name));
}
