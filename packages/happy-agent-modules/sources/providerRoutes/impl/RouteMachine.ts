import { homedir } from "node:os";

/** The machine facts route detection reads. */
export interface RouteMachine {
    readonly platform: NodeJS.Platform;
    /** The daemon's own process environment; detection never runs a shell to learn more. */
    readonly env: Readonly<NodeJS.ProcessEnv>;
    /** Package-manager `bin` folders searched whether or not they are on `PATH`. */
    readonly programDirectories: readonly string[];
}

export function homeOf(machine: RouteMachine): string {
    return machine.env["HOME"]?.trim() || machine.env["USERPROFILE"]?.trim() || homedir();
}

/** A provider ID made from a name found on this computer, such as an AWS profile. */
export function providerIdFrom(prefix: string, name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "_")
        .replace(/^_+|_+$/gu, "")
        .slice(0, 40);
    return slug.length === 0 ? prefix : `${prefix}_${slug}`;
}
