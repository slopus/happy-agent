import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/** A file a scenario starts with: text, bytes, or bytes with a mode that matters. */
export type GymFixture =
    | string
    | Uint8Array
    | { readonly content: string | Uint8Array; readonly mode?: number };

export interface GymHomeOptions {
    /** Files written into the agent's working directory before it starts. */
    readonly files?: Readonly<Record<string, GymFixture>>;
    /** Extra `happy.toml` content, appended after whatever the gym itself configures. */
    readonly config?: string;
    /** The default permission mode for messages whose composer mode does not override it. */
    readonly permissionMode?: "read_only" | "workspace_write" | "auto" | "full_access";
}

export interface GymHome {
    /** The throwaway folder holding both homes. */
    readonly root: string;
    /** Happy's private root, the folder `startHappyAgent` is pointed at. */
    readonly happyHome: string;
    /** The public Happy folder, where the daemon keeps its user-facing configuration. */
    readonly publicHomePath: string;
    /**
     * The agent's working directory, where fixtures land. It is a sibling of the public home
     * rather than the public home itself, because the daemon seeds starter configuration files
     * into the public home and a workspace must only ever hold what the scenario put there.
     */
    readonly workspacePath: string;
    /** Delete everything this home owns. */
    remove(): Promise<void>;
}

/**
 * A Unix socket path may not exceed roughly this many bytes, and the daemon's socket lives several
 * folders below the root. A gym would rather explain that up front than fail inside `listen`.
 */
const MAX_SOCKET_PATH = 100;

/**
 * Make one throwaway Happy installation.
 *
 * It lives under the repository's scratch folder rather than the system temporary directory
 * because the daemon's socket path is bounded, and macOS temporary paths are long enough on their
 * own to exhaust that bound.
 */
export async function createGymHome(options: GymHomeOptions = {}): Promise<GymHome> {
    const scratch = resolve(import.meta.dirname, "../../../.local");
    await mkdir(scratch, { recursive: true });
    const runRoot = await mkdtemp(join(scratch, "r"));
    const root = await mkdtemp(join(runRoot, "i"));
    const happyHome = join(root, ".happy");
    const publicHome = join(root, "Happy");
    const workspacePath = join(root, "workspace");
    const socketPath = join(happyHome, "agent", "server.sock");
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
        await rm(root, { force: true, recursive: true });
        await rm(runRoot, { force: true, recursive: true });
        throw new Error(
            `A gym cannot start here: its socket path would be ${String(
                Buffer.byteLength(socketPath),
            )} bytes, and a Unix socket allows about ${String(MAX_SOCKET_PATH)}. ` +
                "Check the repository out somewhere shorter.",
        );
    }

    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(publicHome, "Config"), { recursive: true });
    const config = [
        ...(options.permissionMode === undefined
            ? []
            : ["[defaults]", `permission_mode = "${options.permissionMode}"`, ""]),
        ...(options.config === undefined ? [] : [options.config, ""]),
    ].join("\n");
    if (config.trim().length > 0) {
        await writeFile(join(publicHome, "Config", "happy.toml"), config, "utf8");
    }

    for (const [path, fixture] of Object.entries(options.files ?? {})) {
        const target = resolveFixturePath(workspacePath, path);
        await mkdir(join(target, ".."), { recursive: true });
        const { content, mode } = normalizeFixture(fixture);
        await writeFile(target, content, mode === undefined ? {} : { mode });
    }

    return {
        happyHome,
        publicHomePath: publicHome,
        remove: async () => {
            await rm(root, { force: true, recursive: true });
            await rm(runRoot, { force: true, recursive: true });
        },
        root,
        workspacePath,
    };
}

/** Fixture paths are relative to the working directory, and may not point outside it. */
export function resolveFixturePath(workspacePath: string, path: string): string {
    if (isAbsolute(path)) {
        throw new Error(`A gym fixture path must be relative, but "${path}" is absolute.`);
    }
    const target = resolve(workspacePath, normalize(path));
    if (target !== workspacePath && !target.startsWith(workspacePath + sep)) {
        throw new Error(`A gym fixture path must stay inside the workspace, but "${path}" leaves.`);
    }
    return target;
}

function normalizeFixture(fixture: GymFixture): {
    content: string | Uint8Array;
    mode: number | undefined;
} {
    if (typeof fixture === "string" || fixture instanceof Uint8Array) {
        return { content: fixture, mode: undefined };
    }
    return { content: fixture.content, mode: fixture.mode };
}
