#!/usr/bin/env node

import { spawnHidden } from "./hiddenChildProcess.js";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { createHappyPluginTestHost } from "./createHappyPluginTestHost.js";
import {
    happyPluginAppResourceMediaType,
    isHappyPluginImageMediaType,
} from "./pluginAppResources.js";
import {
    HAPPY_PLUGIN_MAX_APP_BYTES,
    HAPPY_PLUGIN_MAX_APP_RESOURCES,
    HAPPY_PLUGIN_MAX_RESOURCE_BYTES,
    happyPluginManifestSchema,
    happyPluginResourcePathSchema,
    happyPluginTestSeedSchema,
    type HappyPluginTestSeed,
} from "./types.js";

interface RunnerOptions {
    argumentsValue: unknown;
    call?: string;
    entry: string;
    listTools: boolean;
    seed?: string;
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    await validateManifest(resolve(options.entry));
    const seed = await readSeed(options.seed);
    const host = await createHappyPluginTestHost(seed, {
        onRequest: (request) => {
            process.stdout.write(
                `[fake Happy] ${request.method} ${request.path}${request.body === undefined ? "" : ` ${JSON.stringify(request.body)}`}\n`,
            );
        },
    });
    const child = spawnHidden(process.execPath, [resolve(options.entry)], {
        env: { ...process.env, ...host.environment },
        stdio: "inherit",
    });
    let stopping = false;
    const childExit = new Promise<number>((resolveExit) => {
        child.once("exit", (code) => resolveExit(stopping ? 0 : (code ?? 1)));
        child.once("error", () => resolveExit(1));
    });
    const stop = () => {
        stopping = true;
        child.kill("SIGTERM");
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
        if (options.listTools || options.call !== undefined) {
            await Promise.race([
                host.mcp.waitForTools(),
                childExit.then((code) => {
                    throw new Error(
                        `The plugin exited with code ${String(code)} before registering an MCP server.`,
                    );
                }),
            ]);
            const tools = host.mcp.listTools();
            process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
            if (options.call !== undefined) {
                const separator = Math.max(
                    options.call.lastIndexOf("/"),
                    options.call.lastIndexOf("."),
                );
                if (separator <= 0 || separator === options.call.length - 1) {
                    throw new Error("--call must be SERVER/TOOL or SERVER.TOOL.");
                }
                const result = await host.mcp.callTool(
                    options.call.slice(0, separator),
                    options.call.slice(separator + 1),
                    options.argumentsValue,
                );
                process.stdout.write(`${JSON.stringify({ result }, null, 2)}\n`);
            }
            stop();
        }
        process.exitCode = await childExit;
    } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await host.close();
    }
}

function parseArguments(arguments_: readonly string[]): RunnerOptions {
    if (arguments_[0] !== "dev" || arguments_[1] === undefined) {
        throw new Error(
            "Usage: happy-plugin dev <entry.ts> [--seed seed.json] [--list-tools] [--call SERVER/TOOL] [--arguments JSON]",
        );
    }
    const options: RunnerOptions = {
        argumentsValue: {},
        entry: arguments_[1],
        listTools: false,
    };
    for (let index = 2; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (argument === "--list-tools") {
            options.listTools = true;
            continue;
        }
        if (argument === "--seed" || argument === "--call" || argument === "--arguments") {
            const value = arguments_[++index];
            if (value === undefined) throw new Error(`${argument} requires a value.`);
            if (argument === "--seed") options.seed = value;
            else if (argument === "--call") options.call = value;
            else options.argumentsValue = JSON.parse(value) as unknown;
            continue;
        }
        throw new Error(`Unknown happy-plugin option ${JSON.stringify(argument)}.`);
    }
    return options;
}

async function readSeed(path: string | undefined): Promise<HappyPluginTestSeed> {
    if (path === undefined) return {};
    return Value.Decode(
        happyPluginTestSeedSchema,
        JSON.parse(await readFile(resolve(path), "utf8")),
    );
}

async function validateManifest(entry: string): Promise<void> {
    const directory = dirname(entry);
    let body: string;
    try {
        body = await readFile(join(directory, "happy.plugin.json"), "utf8");
    } catch (error) {
        if (isFileSystemError(error, "ENOENT")) return;
        throw error;
    }
    const manifest = Value.Decode(happyPluginManifestSchema, JSON.parse(body) as unknown);
    for (const app of manifest.apps ?? []) {
        const root = resolveInside(directory, app.root);
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error(`Plugin app "${app.id}" root must be an ordinary directory.`);
        }
        const resources = new Map<string, ReturnType<typeof happyPluginAppResourceMediaType>>();
        let bytes = 0;
        const visit = async (current: string): Promise<void> => {
            for (const item of await readdir(current, { withFileTypes: true })) {
                if (item.name.startsWith(".")) continue;
                const path = join(current, item.name);
                const itemInfo = await lstat(path);
                if (itemInfo.isSymbolicLink()) {
                    throw new Error(`Plugin app "${app.id}" cannot contain symbolic links.`);
                }
                if (itemInfo.isDirectory()) {
                    await visit(path);
                    continue;
                }
                if (!itemInfo.isFile()) {
                    throw new Error(`Plugin app "${app.id}" contains a non-file entry.`);
                }
                if (resources.size >= HAPPY_PLUGIN_MAX_APP_RESOURCES) {
                    throw new Error(`Plugin app "${app.id}" has too many resources.`);
                }
                if (itemInfo.size > HAPPY_PLUGIN_MAX_RESOURCE_BYTES) {
                    throw new Error(`Plugin app "${app.id}" has an oversized resource.`);
                }
                bytes += itemInfo.size;
                if (bytes > HAPPY_PLUGIN_MAX_APP_BYTES) {
                    throw new Error(`Plugin app "${app.id}" is too large.`);
                }
                const resource = relative(root, path).split("\\").join("/");
                Value.Assert(happyPluginResourcePathSchema, resource);
                const mediaType = happyPluginAppResourceMediaType(resource);
                if (mediaType === undefined) {
                    throw new Error(
                        `Plugin app "${app.id}" resource "${resource}" has an unsupported file type.`,
                    );
                }
                resources.set(resource, mediaType);
            }
        };
        await visit(root);
        if (resources.get(app.page) !== "text/html") {
            throw new Error(`Plugin app "${app.id}" page must name an HTML resource.`);
        }
        if (app.sidebar.icon !== undefined) {
            const iconMediaType = resources.get(app.sidebar.icon);
            if (iconMediaType === undefined) {
                throw new Error(`Plugin app "${app.id}" sidebar icon does not exist.`);
            }
            if (!isHappyPluginImageMediaType(iconMediaType)) {
                throw new Error(`Plugin app "${app.id}" sidebar icon must be an image.`);
            }
        }
    }
}

function resolveInside(directory: string, value: string): string {
    const root = resolve(directory);
    const path = resolve(root, value);
    const fromRoot = relative(root, path);
    if (fromRoot === "" || fromRoot.startsWith("..") || fromRoot.startsWith("/")) {
        throw new Error("Plugin app roots must stay inside the plugin folder.");
    }
    return path;
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error && error.code === code;
}

void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
