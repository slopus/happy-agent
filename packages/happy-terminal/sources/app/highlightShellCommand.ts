const RESET_FOREGROUND = "\x1b[39m";
const BLUE = "\x1b[38;5;75m";
const CYAN = "\x1b[38;5;73m";
const GREEN = "\x1b[38;5;71m";
const MAGENTA = "\x1b[38;5;168m";
const RED = "\x1b[38;5;203m";

export function highlightShellCommand(command: string): string {
    let result = "";
    let index = 0;
    let expectsCommand = true;

    while (index < command.length) {
        const character = command[index] ?? "";
        if (/\s/u.test(character)) {
            result += character;
            index += 1;
            continue;
        }

        if (character === "'" || character === '"') {
            const end = quotedEnd(command, index, character);
            result += color(GREEN, command.slice(index, end));
            index = end;
            expectsCommand = false;
            continue;
        }

        if (character === "$" && /[A-Za-z_{]/u.test(command[index + 1] ?? "")) {
            const match = command.slice(index).match(/^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/u);
            const value = match?.[0] ?? character;
            result += color(RED, value);
            index += value.length;
            continue;
        }

        if (/[|&;<>]/u.test(character)) {
            const match = command.slice(index).match(/^(?:\|\||&&|>>|<<|[|&;<>])/u);
            const value = match?.[0] ?? character;
            result += color(CYAN, value);
            index += value.length;
            expectsCommand = true;
            continue;
        }

        const match = command.slice(index).match(/^[^\s'"$|&;<>]+/u);
        const value = match?.[0] ?? character;
        const style = value.startsWith("-")
            ? MAGENTA
            : expectsCommand
              ? BLUE
              : value.includes("/") || value.startsWith(".")
                ? GREEN
                : "";
        result += style.length === 0 ? value : color(style, value);
        index += value.length;
        expectsCommand = false;
    }

    return result;
}

function quotedEnd(command: string, start: number, quote: string): number {
    for (let index = start + 1; index < command.length; index += 1) {
        if (quote === '"' && command[index] === "\\") {
            index += 1;
            continue;
        }
        if (command[index] === quote) return index + 1;
    }
    return command.length;
}

function color(ansi: string, text: string): string {
    return `${ansi}${text}${RESET_FOREGROUND}`;
}
