import type { Context } from "@steve.kite/stdlib";

import type { ComputeFileSystem } from "./ComputeFileSystem.js";
import type { ComputeShell } from "./ComputeShell.js";
import type { ComputeServices } from "./ComputeServices.js";

/**
 * What sort of machine a compute is, as opposed to which provider built it.
 *
 * There are only three shapes, and the difference between them is where the agent's mistakes land:
 * `host` is the real computer a person is sitting at, `docker` is a container that can be thrown
 * away, and `emulated` is not a machine at all but a shell answered in this process. A caller that
 * has to reason about that — a warning, a confirmation, a refusal — asks this rather than
 * enumerating provider ids, because the set of providers is open and the set of shapes is not.
 */
export type ComputeKind = "host" | "docker" | "emulated";

/**
 * The machine an agent works on: one filesystem and one shell.
 *
 * Everything above this line — tools, features, the agent loop — is written once against this
 * interface, and everything below it is a backend: the host itself, a shell emulated in process,
 * or a container. Which one an agent gets is chosen when it is built and never afterwards, so
 * nothing the agent does can move it to another machine.
 *
 * A compute holds no permissions of its own. Every read, write, and command carries the boundary
 * it runs under, because permission belongs to an action rather than to a machine: the same
 * workspace answers a reviewed command and an ordinary one differently, and a decision made for
 * one action must never leak into the next.
 *
 * A compute owns what it started. Commands left running in the background belong to it, and
 * disposing it is what ends them.
 */
export interface Compute {
    /**
     * The id of the provider that built this machine, for the rare caller that must say out loud
     * which one it got.
     */
    readonly id: string;
    /** What sort of machine this is. */
    readonly kind: ComputeKind;
    /** The directory the agent works in, in this machine's own paths. */
    readonly cwd: string;
    /** The filesystem. */
    readonly fs: ComputeFileSystem;
    /** The shell. */
    readonly shell: ComputeShell;
    /** Mandatory isolated services, when this backend can enforce that separate boundary. */
    readonly services?: ComputeServices;
    /** Stop everything this compute started and release what it holds. */
    dispose(ctx: Context): Promise<void>;
}
