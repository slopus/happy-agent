import { HappyTerminalUserError } from "../HappyTerminalUserError.js";

/** A directory shared between the machine running Happy Terminal and the container. */
export interface SessionDockerMount {
    source: string;
    target: string;
    readOnly?: boolean;
}

/** Where a session should run when it is not running on this machine directly. */
export interface SessionDockerEnvironment {
    /** The image Happy Terminal starts a fresh container from, when one was chosen. */
    image?: string;
    /** An already running container Happy Terminal attaches to, when one was chosen. */
    container?: string;
    environment: Record<string, string>;
    mounts: readonly SessionDockerMount[];
    workingDirectory?: string;
}

export interface ParsedSessionEnvironmentOptions {
    debug?: boolean;
    /** The container to run in, `null` when the session was explicitly kept local. */
    docker?: SessionDockerEnvironment | null;
    remaining: readonly string[];
}

export function parseSessionEnvironmentOptions(
    args: readonly string[],
): ParsedSessionEnvironmentOptions {
    const remaining: string[] = [];
    const environment: Record<string, string> = {};
    const mounts: SessionDockerMount[] = [];
    let debug = false;
    let local = false;
    let image: string | undefined;
    let container: string | undefined;
    let workingDirectory: string | undefined;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === "--debug") {
            debug = true;
            continue;
        }
        if (argument === "--local") {
            local = true;
            continue;
        }
        if (
            argument === "--docker-image" ||
            argument === "--docker-container" ||
            argument === "--docker-workdir" ||
            argument === "--docker-env" ||
            argument === "--docker-mount"
        ) {
            index += 1;
            const value = args[index];
            if (value === undefined) {
                throw new HappyTerminalUserError(
                    `Happy Terminal needs a value after ${argument}.`,
                    {
                        hint: `Usage: ${argument} ${describeExpectedValue(argument)}`,
                    },
                );
            }
            if (argument === "--docker-image") image = value;
            else if (argument === "--docker-container") container = value;
            else if (argument === "--docker-workdir") workingDirectory = value;
            else if (argument === "--docker-env") {
                const separator = value.indexOf("=");
                if (separator <= 0) {
                    throw new HappyTerminalUserError(
                        `Happy Terminal cannot read '${value}' as an environment variable.`,
                        { hint: "Usage: --docker-env NAME=value" },
                    );
                }
                environment[value.slice(0, separator)] = value.slice(separator + 1);
            } else {
                mounts.push(parseMount(value));
            }
            continue;
        }
        remaining.push(argument);
    }

    if (image !== undefined && container !== undefined) {
        throw new HappyTerminalUserError(
            "Happy Terminal can start a new container from an image or attach to a running one. Choose one.",
            { hint: "Pass either --docker-image or --docker-container." },
        );
    }
    const docker = image !== undefined || container !== undefined;
    if (local && docker) {
        throw new HappyTerminalUserError(
            "Happy Terminal can run this session locally or in a container. Choose one.",
            {
                hint: "Pass either --local or the --docker options.",
            },
        );
    }
    if (!docker && (Object.keys(environment).length > 0 || mounts.length > 0)) {
        throw new HappyTerminalUserError(
            "Happy Terminal needs to know which container these options belong to.",
            {
                hint: "Add --docker-image or --docker-container.",
            },
        );
    }
    if (!docker && workingDirectory !== undefined) {
        throw new HappyTerminalUserError(
            "Happy Terminal needs to know which container that working directory belongs to.",
            { hint: "Add --docker-image or --docker-container." },
        );
    }

    return {
        ...(debug ? { debug: true } : {}),
        ...(docker
            ? {
                  docker: {
                      ...(image === undefined ? {} : { image }),
                      ...(container === undefined ? {} : { container }),
                      environment,
                      mounts,
                      ...(workingDirectory === undefined ? {} : { workingDirectory }),
                  },
              }
            : local
              ? { docker: null }
              : {}),
        remaining,
    };
}

function parseMount(value: string): SessionDockerMount {
    const parts = value.split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => part.length === 0)) {
        throw new HappyTerminalUserError(
            `Happy Terminal cannot read '${value}' as a shared directory.`,
            {
                hint: "Usage: --docker-mount <local path>:<container path>[:ro]",
            },
        );
    }
    const [source, target, mode] = parts as [string, string, string | undefined];
    if (mode !== undefined && mode !== "ro" && mode !== "rw") {
        throw new HappyTerminalUserError(
            `Happy Terminal does not understand the mount option '${mode}'.`,
            {
                hint: "The third part of a mount must be 'ro' or 'rw'.",
            },
        );
    }
    return { source, target, ...(mode === "ro" ? { readOnly: true } : {}) };
}

function describeExpectedValue(option: string): string {
    if (option === "--docker-image") return "<image>";
    if (option === "--docker-container") return "<container name>";
    if (option === "--docker-workdir") return "<container path>";
    if (option === "--docker-env") return "NAME=value";
    return "<local path>:<container path>[:ro]";
}
