import type { PermissionMode } from "../protocol/index.js";
import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import { parsePermissionMode } from "./parsePermissionMode.js";

export interface ExecCommandOptions {
    debug?: boolean;
    effort?: string;
    fork: boolean;
    last: boolean;
    modelId?: string;
    outputFormat: "json" | "stream-json" | "text";
    permissionMode?: PermissionMode;
    prompt?: string;
    providerId?: string;
    resumeSessionId?: string;
}

export function parseExecCommand(args: readonly string[]): ExecCommandOptions {
    const options: ExecCommandOptions = {
        fork: false,
        last: false,
        outputFormat: "text",
    };
    const prompt: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--") {
            prompt.push(...args.slice(index + 1));
            break;
        }
        if (arg === "--json") {
            if (options.outputFormat === "stream-json") {
                throw new HappyTerminalUserError(
                    "Choose either --json or --stream-json, not both.",
                );
            }
            options.outputFormat = "json";
            continue;
        }
        if (arg === "--stream-json") {
            if (options.outputFormat === "json") {
                throw new HappyTerminalUserError(
                    "Choose either --json or --stream-json, not both.",
                );
            }
            options.outputFormat = "stream-json";
            continue;
        }
        if (arg === "--fork") {
            options.fork = true;
            continue;
        }
        if (arg === "--last") {
            options.last = true;
            continue;
        }
        if (arg === "--resume") {
            options.resumeSessionId = requiredValue(args, ++index, arg);
            continue;
        }
        if (arg === "--model") {
            options.modelId = requiredValue(args, ++index, arg);
            continue;
        }
        if (arg === "--provider") {
            options.providerId = requiredValue(args, ++index, arg);
            continue;
        }
        if (arg === "--effort") {
            options.effort = requiredValue(args, ++index, arg);
            continue;
        }
        if (arg === "--permission-mode") {
            options.permissionMode = parsePermissionMode(requiredValue(args, ++index, arg));
            continue;
        }
        if (arg?.startsWith("-")) {
            throw new HappyTerminalUserError(`Unknown happy-terminal exec option '${arg}'.`);
        }
        if (arg !== undefined) prompt.push(arg);
    }

    if (options.last && options.resumeSessionId !== undefined) {
        throw new HappyTerminalUserError("Choose either --last or --resume, not both.");
    }
    if (options.fork && !options.last && options.resumeSessionId === undefined) {
        throw new HappyTerminalUserError("--fork requires --last or --resume <session-id>.");
    }
    if (prompt.length > 0) options.prompt = prompt.join(" ");
    return options;
}

function requiredValue(args: readonly string[], index: number, option: string): string {
    const value = args[index];
    if (value === undefined || value.startsWith("-")) {
        throw new HappyTerminalUserError(`${option} requires a value.`);
    }
    return value;
}
