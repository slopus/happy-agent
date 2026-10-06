import type { ComputeToolVendor } from "../ComputeToolVendor.js";
import type { Compute } from "../Compute.js";
import { claudeShellName } from "../tools/claude/impl/claudeShellName.js";

/**
 * What the agent is told about the machine, in the names its own tools actually have.
 *
 * The two rules worth stating are the same everywhere — an unremembered file may be changed but a
 * remembered stale one is refused, and a command that outlives its wait keeps running. A rule
 * that names a tool the model does not have is worse than no rule at all, so each vendor is told
 * them in its own vocabulary.
 */
export function computeInstructionsForVendor(vendor: ComputeToolVendor, compute: Compute): string {
    if (vendor === "claude" || vendor === "glm") {
        const shell = claudeShellName(compute);
        return instructionsByVendor[vendor]
            .replaceAll("BashOutput", `${shell}Output`)
            .replaceAll("BashInput", `${shell}Input`)
            .replaceAll("BashStop", `${shell}Stop`);
    }
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
    kimi: [
        "Read and Edit use a text view without line-number prefixes. Pure CRLF files display LF and keep CRLF when edited. Write appends only when mode is append; use Edit for incremental changes. Remembered files changed on disk must be read again before editing.",
        "Bash timeout is a wait in seconds. A command that outlives its wait keeps running with a task_id. TaskOutput returns only new output without waiting; TaskInput sends characters and TaskStop ends the process tree. Completion notifications arrive automatically.",
        "ReadMediaFile accepts filesystem images only; this Bedrock route does not support video or Kimi session attachment URLs.",
    ].join("\n"),
    glm: [
        "Write and Edit can change an existing file without a prior Read. If a file was read or written earlier and then changed on disk, the stale change is refused; Read it again first.",
        "A command that outlives its timeout keeps running and returns a shell ID. BashOutput returns only new output; BashInput sends characters and BashStop ends the process tree.",
        "This model accepts text only. Read returns a clear unsupported result for images; convert them to text before reading.",
    ].join("\n"),
});
