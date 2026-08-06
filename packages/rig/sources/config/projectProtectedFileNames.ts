import { PROJECT_CONFIG_FILE_NAMES } from "./projectConfigFileNames.js";

/** Root project files that require Full access to create or modify. */
export const PROJECT_PROTECTED_FILE_NAMES = [
    ...PROJECT_CONFIG_FILE_NAMES,
    "AGENTS_SECURITY.md",
] as const;