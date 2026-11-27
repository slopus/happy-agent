export const MAX_ACTIVE_HOST_SESSIONS = 64;
export const MAX_RETAINED_HOST_SESSIONS = 64;

/** The default patience for a foreground command before it is backgrounded or ends. */
export const DEFAULT_HOST_COMMAND_TIMEOUT_MS = 120_000;

/** The default cap on how much of a command's output is retained. */
export const DEFAULT_HOST_MAX_OUTPUT_BYTES = 512_000;

/**
 * How long a command has to shut itself down before it is forced.
 *
 * A dev server flushing state or a build removing a lock file deserves a
 * moment; two seconds is long enough to be polite and short enough that
 * stopping still feels immediate.
 */
export const HOST_SESSION_STOP_GRACE_MS = 2_000;

/**
 * How often a read waiting on a quiet command looks at whether it is blocked on its input.
 *
 * The kernel announces nothing when a process starts waiting in `read`, so the only way to see it
 * is to look. Looking is one pass over procfs, and only while a read is actually waiting and the
 * command has written nothing since the last look, so a command that is producing output or that
 * nobody is reading costs nothing. A second is quick enough that a stuck command comes back almost
 * at once. Nothing is ever stopped because of what this finds.
 */
export const HOST_INPUT_WAIT_CHECK_MS = 1_000;
