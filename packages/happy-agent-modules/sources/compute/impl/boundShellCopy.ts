import type { ComputeShell } from "@slopus/happy-agent-compute";

/**
 * A plain object carrying the shell's own values and its methods bound to it, so replacing a
 * method here never reaches into the original and private state still resolves.
 */
export function boundShellCopy(shell: ComputeShell): ComputeShell {
    const copy: Record<string, unknown> = {};
    for (
        let source: object | null = shell;
        source !== null && source !== Object.prototype;
        source = Object.getPrototypeOf(source) as object | null
    ) {
        for (const key of Object.getOwnPropertyNames(source)) {
            if (key === "constructor" || key in copy) continue;
            const value = (shell as unknown as Record<string, unknown>)[key];
            copy[key] =
                typeof value === "function"
                    ? (value as (...args: unknown[]) => unknown).bind(shell)
                    : value;
        }
    }
    return copy as unknown as ComputeShell;
}
