/**
 * Work refused because it would run on the daemon's own machine while runners are configured.
 *
 * Once any runner exists, folders live on runners and nothing falls back to this machine, so a
 * folder registered here earlier can still be listed and archived but not worked on.
 */
export class LocalExecutionDisabledError extends Error {
    override readonly name = "LocalExecutionDisabledError";
    readonly status = 409;
    readonly code = "local_execution_disabled";

    constructor(
        message = "Runners are configured, so nothing runs on the daemon's own machine. Use a project on a runner.",
    ) {
        super(message);
    }
}
