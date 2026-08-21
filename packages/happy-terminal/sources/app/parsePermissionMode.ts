import type { PermissionMode } from "../protocol/index.js";

const INVALID_PERMISSION_MODE_MESSAGE =
    "Permission mode must be auto, workspace_write, read_only, or full_access.";

export function parsePermissionMode(value: unknown): PermissionMode {
    if (
        value === "auto" ||
        value === "workspace_write" ||
        value === "read_only" ||
        value === "full_access"
    ) {
        return value;
    }
    throw new Error(INVALID_PERMISSION_MODE_MESSAGE);
}
