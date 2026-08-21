import type { ComputeToolVendor } from "../ComputeToolVendor.js";

/**
 * What the agent is told about the machine, in the names its own tools actually have.
 *
 * The two rules worth stating are the same everywhere — an unremembered file may be changed but a
 * remembered stale one is refused, and a command that outlives its wait keeps running. A rule
 * that names a tool the model does not have is worse than no rule at all, so each vendor is told
 * them in its own vocabulary.
 */
export function computeInstructionsForVendor(vendor: ComputeToolVendor): string {
    return instructionsByVendor[vendor];
}

const instructionsByVendor: Readonly<Record<ComputeToolVendor, string>> = Object.freeze({
    claude: [
        "Write and Edit can change an existing file without a prior Read. If a file was read or written earlier and then changed on disk, the stale change is refused; Read it again first.",
        "A command that outlives its timeout is not killed. It keeps running and comes back with a shell ID, and every later BashOutput of it returns only what is new.",
    ].join("\n"),
    codex: [
        "apply_patch can change an existing file without a prior read. Context quoted by an update must match the current file, or the patch is refused.",
        "A command that outlives its yield time is not killed. It keeps running and comes back with a session ID, and every later write_stdin poll of it returns only what is new.",
    ].join("\n"),
    grok: [
        "write and search_replace can change an existing file without a prior read_file. If a file was read or written earlier and then changed on disk, the stale change is refused; read_file it again first.",
        "A command that outlives its timeout is not killed. It keeps running and comes back with a task ID, and every later get_command_or_subagent_output of it returns only what is new.",
    ].join("\n"),
});
