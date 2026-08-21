import { errorToMessage } from "./errorToMessage.js";
import { isHappyTerminalUserError } from "./HappyTerminalUserError.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const MAX_STACK_FRAMES = 4;
const UNEXPECTED_TITLE = "Happy Terminal stopped unexpectedly.";

export interface FormatCliFailureOptions {
    /** Prints the untouched stack instead of the trimmed frame list. */
    debug?: boolean;
    color?: boolean;
}

/**
 * Renders a failure the way the rest of Happy Terminal looks: a marked summary line, an actionable hint,
 * and — only for unexpected crashes — a few trimmed frames instead of a raw Node stack.
 */
export function formatCliFailure(error: unknown, options: FormatCliFailureOptions = {}): string {
    const color = options.color ?? true;
    const paint = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text);
    const expected = isHappyTerminalUserError(error);
    const summary = expected ? errorToMessage(error) : UNEXPECTED_TITLE;
    const lines = [`${paint(`${BOLD}${RED}`, "✗")} ${paint(BOLD, summary)}`];

    if (expected) {
        const hint = error.hint;
        if (hint !== undefined) lines.push(`  ${paint(DIM, hint)}`);
    } else {
        lines.push(`  ${errorToMessage(error)}`);
        const details = options.debug === true ? rawStack(error) : trimmedFrames(error);
        if (details.length > 0) {
            lines.push("");
            lines.push(...details.map((line) => `  ${paint(DIM, line)}`));
        }
        if (options.debug !== true) {
            lines.push("");
            lines.push(`  ${paint(DIM, "Run the same command with --debug for the full stack.")}`);
        }
    }

    return ["", ...lines, ""].join("\n");
}

function rawStack(error: unknown): readonly string[] {
    const stack = error instanceof Error ? error.stack : undefined;
    return stack === undefined
        ? []
        : stack
              .split("\n")
              .slice(1)
              .map((frame) => frame.trim());
}

/**
 * Node's default trace is mostly absolute paths and framework frames. Keep the first few frames
 * that belong to Happy Terminal, written the way the repository refers to them.
 */
function trimmedFrames(error: unknown): readonly string[] {
    const stack = error instanceof Error ? error.stack : undefined;
    if (stack === undefined) return [];
    // Node's own frames have to go before trimming, which drops the `node:` scheme they carry.
    const frames = stack
        .split("\n")
        .slice(1)
        .filter((frame) => !frame.includes("node:"))
        .map(trimFrame)
        .filter((frame) => frame.length > 0);
    const owned = frames.filter((frame) => !frame.includes("node_modules"));
    return (owned.length > 0 ? owned : frames).slice(0, MAX_STACK_FRAMES);
}

function trimFrame(frame: string): string {
    const location = /\(?((?:\/|[A-Za-z]:\\)[^()]+?):(\d+):(\d+)\)?$/u.exec(frame.trim());
    if (location === null) return frame.trim().replace(/^at\s+/u, "");
    const name = frame
        .trim()
        .replace(/^at\s+/u, "")
        .replace(/\s*\(.*\)$/u, "");
    const path = shortenSourcePath(location[1] ?? "");
    const position = `${path}:${location[2] ?? ""}`;
    return name.startsWith("/") || name.length === 0 ? position : `${position} — ${name}`;
}

/** Repository-relative paths read far better than the machine-specific absolute ones. */
function shortenSourcePath(path: string): string {
    const packages = path.lastIndexOf("/packages/");
    if (packages >= 0) return path.slice(packages + 1);
    const nodeModules = path.lastIndexOf("/node_modules/");
    if (nodeModules >= 0) return path.slice(nodeModules + 1);
    return path;
}
