import type { Socket } from "node:net";

import { Value } from "@sinclair/typebox/value";

import { tailcatAddressSchema } from "./Tailcat.js";
import { resolveTailcatExecutable } from "./impl/resolveTailcatExecutable.js";
import { TailcatConnection } from "./impl/TailcatConnection.js";

/** A carrier to one Tailcat-exposed daemon, opening connections to its ports. */
export interface TailcatRemote {
    connect(port: number): Promise<Socket>;
    close(): Promise<void>;
}

/**
 * Reach a Tailcat-exposed daemon from a process that is not one: a runner dialing its standalone
 * daemon. It lives outside the module index so a runner loads none of the daemon to use it.
 */
export function openTailcatRemote(address: string): TailcatRemote {
    if (!Value.Check(tailcatAddressSchema, address)) {
        throw new Error("The Tailcat address is not an address Tailcat printed.");
    }
    return new TailcatConnection(resolveTailcatExecutable(), address);
}
