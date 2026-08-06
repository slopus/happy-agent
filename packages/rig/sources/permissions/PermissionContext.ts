import type { PermissionMode } from "./PermissionMode.js";

export interface PermissionContext {
    readonly mode: PermissionMode;
    readonly protectedPaths: readonly string[];
    readonly revision: number;
    runWithMode<T>(mode: PermissionMode, action: () => Promise<T> | T): Promise<T>;
    setMode(mode: PermissionMode): void;
}
