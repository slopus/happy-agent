import { ApiError } from "../ApiError.js";

/**
 * Whether the caller may read a viewer target: `check` passes, or refuses it with `404`. A
 * permanent deletion committing while `check` walks the agent makes Agent Base throw a plain
 * missing-agent error partway through; when the target is gone by then, it is simply unreadable.
 * Any other failure is thrown.
 */
export async function viewerTargetReadable(
    check: () => Promise<void>,
    exists: () => Promise<boolean>,
): Promise<boolean> {
    try {
        await check();
        return true;
    } catch (error: unknown) {
        if (error instanceof ApiError && error.status === 404) return false;
        if (!(await exists())) return false;
        throw error;
    }
}
