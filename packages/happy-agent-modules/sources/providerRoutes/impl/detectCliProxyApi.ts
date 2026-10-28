import { accessSync, constants, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { homeOf, type RouteMachine } from "./RouteMachine.js";

const DEFAULT_PORT = 8317;
const PROBE_TIMEOUT_MS = 1_500;
const MAX_CONFIG_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_MODELS = 500;

/** Who serves the models CLIProxyAPI lists, by its `owned_by` value. */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
    anthropic: "Anthropic",
    claude: "Anthropic",
    openai: "OpenAI",
    codex: "OpenAI",
    xai: "xAI",
    grok: "xAI",
    google: "Google",
    gemini: "Google",
    antigravity: "Google",
};

const modelListSchema = Type.Object({
    data: Type.Array(
        Type.Object({
            id: Type.String({ minLength: 1, maxLength: 512 }),
            owned_by: Type.Optional(Type.String({ maxLength: 256 })),
        }),
    ),
});

export interface CliProxyApiModel {
    readonly id: string;
    /** The vendor serving it, for display, or null when the proxy does not say. */
    readonly vendor: string | null;
}

export interface CliProxyApiDetection {
    /** The `cliproxyapi` or `cli-proxy-api` program, when one is installed. It is never run. */
    readonly program: string | null;
    readonly configPath: string | null;
    readonly port: number;
    /**
     * The first client key from the proxy's own `access.api-keys`. It is the proxy's key, not a
     * vendor credential, and only ever sent to 127.0.0.1. Never project it to a client.
     */
    readonly apiKey: string | null;
    /** `running` lists models; `unauthorized` answered but refused the key; `stopped` did not answer. */
    readonly status: "running" | "unauthorized" | "stopped";
    readonly models: readonly CliProxyApiModel[];
    /** Distinct vendors behind the listed models, in display form, sorted. */
    readonly vendors: readonly string[];
}

interface CliProxyApiConfig {
    readonly port: number;
    readonly apiKeys: readonly string[];
}

/**
 * Find a CLIProxyAPI the person already runs, read-only: its program and configuration, and the
 * models its local server lists right now. It never starts, installs, or signs in to the proxy,
 * never reads its account tokens, and only talks to 127.0.0.1. Returns null when nothing of it
 * is on this computer.
 */
export async function detectCliProxyApi(
    machine: RouteMachine,
): Promise<CliProxyApiDetection | null> {
    const program = findProgram(machine);
    const configPath = await findConfig(machine, program);
    if (program === null && configPath === null) return null;
    const config =
        configPath === null
            ? { port: DEFAULT_PORT, apiKeys: [] }
            : parseCliProxyApiConfig(await readFile(configPath, "utf8"));
    const apiKey = config.apiKeys[0] ?? null;
    const probe = await listModels(config.port, apiKey);
    return { program, configPath, port: config.port, apiKey, ...probe };
}

/**
 * Read only `port` and the client `api-keys` from a CLIProxyAPI config. The v8 layout nests them
 * under `server` and `access`; the legacy layout keeps them at the top level. As in the proxy
 * itself, a v8 value wins when both are present, even an empty list.
 */
export function parseCliProxyApiConfig(text: string): CliProxyApiConfig {
    const lines = text
        .slice(0, MAX_CONFIG_BYTES)
        .split(/\r?\n/)
        .map((raw) => stripComment(raw))
        .filter((line) => line.trim().length > 0);
    const values = new Map<string, string | string[]>();
    let section: string | undefined;
    let childIndent: number | undefined;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const indent = line.length - line.trimStart().length;
        const entry = /^([\w.-]+)\s*:\s*(.*)$/.exec(line.trim());
        if (indent === 0) {
            section = entry !== null && entry[2] === "" ? entry[1] : undefined;
            childIndent = undefined;
        } else if (section !== undefined && childIndent === undefined) {
            childIndent = indent;
        }
        if (entry === null) continue;
        const [, key = "", value = ""] = entry;
        const path =
            indent === 0
                ? key
                : indent === childIndent && section !== undefined
                  ? `${section}.${key}`
                  : undefined;
        if (path === undefined) continue;
        if (value !== "") {
            values.set(path, value.startsWith("[") ? inlineList(value) : unquote(value));
            continue;
        }
        const items: string[] = [];
        while (index + 1 < lines.length) {
            const next = lines[index + 1] ?? "";
            const item = /^(\s*)-\s*(.*)$/.exec(next);
            if (item === null || (item[1]?.length ?? 0) < indent) break;
            const itemValue = unquote(item[2] ?? "");
            if (itemValue.length > 0) items.push(itemValue);
            index += 1;
        }
        values.set(path, items);
    }
    const port = Number(scalar(values.get("server.port") ?? values.get("port")));
    const keys = values.get("access.api-keys") ?? values.get("api-keys");
    return {
        port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT,
        apiKeys: Array.isArray(keys) ? keys : [],
    };
}

async function listModels(
    port: number,
    apiKey: string | null,
): Promise<Pick<CliProxyApiDetection, "status" | "models" | "vendors">> {
    const stopped = { status: "stopped" as const, models: [], vendors: [] };
    let response: Response;
    try {
        response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`, {
            headers: apiKey === null ? {} : { authorization: `Bearer ${apiKey}` },
            redirect: "error",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
    } catch {
        return stopped;
    }
    if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return { status: "unauthorized", models: [], vendors: [] };
    }
    let body: unknown;
    try {
        const text = await response.text();
        body = response.ok && text.length <= MAX_RESPONSE_BYTES ? JSON.parse(text) : undefined;
    } catch {
        body = undefined;
    }
    // Something else answers on that port: it is not a CLIProxyAPI we can use.
    if (!Value.Check(modelListSchema, body)) return stopped;
    const models = body.data.slice(0, MAX_MODELS).map((model) => ({
        id: model.id,
        vendor:
            model.owned_by === undefined
                ? null
                : (VENDOR_NAMES[model.owned_by.toLowerCase()] ?? model.owned_by),
    }));
    const vendors = [
        ...new Set(models.flatMap((model) => (model.vendor === null ? [] : [model.vendor]))),
    ].sort();
    return { status: "running", models, vendors };
}

function findProgram(machine: RouteMachine): string | null {
    const names = ["cliproxyapi", "cli-proxy-api"].map((name) =>
        machine.platform === "win32" ? `${name}.exe` : name,
    );
    const directories = [
        ...machine.programDirectories,
        ...(machine.env["PATH"] ?? "").split(delimiter),
    ];
    for (const directory of directories) {
        if (directory.length === 0) continue;
        for (const name of names) {
            const path = join(directory, name);
            if (isExecutable(path, machine.platform)) return path;
        }
    }
    return null;
}

/**
 * The places CLIProxyAPI's own installs keep their config: the auth folder the docs recommend,
 * the Linux installer's folder, Homebrew's `etc/cliproxyapi.conf` beside each package-manager
 * `bin`, and `config.yaml` beside the program, its default when run from a download.
 */
async function findConfig(machine: RouteMachine, program: string | null): Promise<string | null> {
    const home = homeOf(machine);
    const candidates = [
        join(home, ".cli-proxy-api", "config.yaml"),
        join(home, "cliproxyapi", "config.yaml"),
        ...machine.programDirectories.map((bin) => join(dirname(bin), "etc", "cliproxyapi.conf")),
        ...(program === null ? [] : [join(dirname(program), "config.yaml")]),
    ];
    for (const path of candidates) {
        try {
            if (statSync(path).isFile()) return path;
        } catch {
            // Not there.
        }
    }
    return null;
}

function stripComment(line: string): string {
    let quote: string | undefined;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote !== undefined) {
            if (char === quote) quote = undefined;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
            return line.slice(0, index).trimEnd();
        }
    }
    return line.trimEnd();
}

function inlineList(value: string): string[] {
    return value
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter((item) => item.length > 0);
}

function unquote(value: string): string {
    const trimmed = value.trim();
    const quoted = /^(["'])(.*)\1$/.exec(trimmed);
    return quoted === null ? trimmed : (quoted[2] ?? "");
}

function scalar(value: string | string[] | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
    try {
        if (!statSync(path).isFile()) return false;
        if (platform !== "win32") accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}
