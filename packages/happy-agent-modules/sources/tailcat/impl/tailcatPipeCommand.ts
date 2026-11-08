import type { TailcatTransportTarget } from "../Tailcat.js";

const TARGET_VARIABLE = "HAPPY_AGENT_TAILCAT_TARGET";
/** How long a pipe whose peer half-closed waits on a daemon that has stopped sending. */
const HALF_CLOSED_QUIET_MS = 60_000;

/**
 * One connection's pipe, run by Tailcat's exec service with the connection as its stdin and
 * stdout. It joins them to the API transport and exits once the daemon's side has ended and its
 * last bytes reached the peer. A peer's half-close is passed on as one, so the reply still
 * arrives whole; a peer that left only half-closed exits once the daemon has been quiet for
 * {@link HALF_CLOSED_QUIET_MS}, so a pipe left behind by a stopped Tailcat exits too. Node and
 * Bun both run it with `-e`.
 */
const PIPE_SCRIPT = [
    "const net = require('node:net');",
    `const target = JSON.parse(process.env.${TARGET_VARIABLE});`,
    "const upstream = net.connect({ ...target, allowHalfOpen: true });",
    "const exit = () => process.exit(0);",
    "upstream.on('error', exit);",
    "process.stdin.on('error', exit);",
    "process.stdout.on('error', exit);",
    "upstream.once('connect', () => {",
    "    process.stdin.pipe(upstream);",
    "    upstream.pipe(process.stdout);",
    "});",
    // Exiting as soon as the peer half-closed dropped every reply byte still on its way.
    "let quiet;",
    `const wait = () => { clearTimeout(quiet); quiet = setTimeout(exit, ${String(HALF_CLOSED_QUIET_MS)}); };`,
    "upstream.once('finish', () => { wait(); upstream.on('data', wait); });",
    // A pipe never ends stdout, so the daemon's close ends it here and exits once it has flushed.
    // Bun calls back an empty write before earlier output is flushed, and exiting then drops it.
    "upstream.once('end', () => process.stdout.end(exit));",
].join("\n");

export interface TailcatPipeCommand {
    /** The command and arguments after `tailcat serve exec --`. */
    readonly command: readonly string[];
    /** Variables Tailcat must carry to every pipe it runs. */
    readonly environment: Readonly<Record<string, string>>;
}

/**
 * What Tailcat runs for each connection instead of proxying to a local port, so no exposure
 * binds one. It is this process's own runtime: Node or Bun from source, and the standalone
 * binary acting as Bun, which `BUN_BE_BUN` asks for and every other runtime ignores.
 */
export function tailcatPipeCommand(target: TailcatTransportTarget): TailcatPipeCommand {
    const connectTo =
        "socketPath" in target
            ? { path: target.socketPath }
            : { host: connectableHost(target.host), port: target.port };
    return {
        command: [process.execPath, "-e", PIPE_SCRIPT],
        environment: { BUN_BE_BUN: "1", [TARGET_VARIABLE]: JSON.stringify(connectTo) },
    };
}

function connectableHost(host: string): string {
    if (host === "0.0.0.0") return "127.0.0.1";
    if (host === "::" || host === "0:0:0:0:0:0:0:0") return "::1";
    return host;
}
