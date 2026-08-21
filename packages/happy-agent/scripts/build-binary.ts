import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire, type Require } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

import { resolveBinaryVersion } from "./resolveBinaryVersion.js";

const MINIMUM_BUN_VERSION = [1, 4, 0] as const;
const VIRTUAL_ASSETS_MODULE = "happy-agent:binary-assets";
const happyAgentRoot = resolve(import.meta.dirname, "..");

interface BinaryTarget {
    arch: "arm64" | "x64";
    bunTarget: string;
    key: "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";
    platform: "darwin" | "linux";
}

interface EmbeddedAsset {
    contents?: string;
    executable?: boolean;
    relativePath: string;
    source?: string;
    variable: string;
}

type JustBashWorker = "javascript" | "sqlite";

interface JustBashWorkerGroup {
    relativePath: string;
    variables: string[];
}

interface BinaryAssets {
    assets: EmbeddedAsset[];
    claudeRelativePath: string;
    fffRelativePath: string;
    ffiRelativePath: string;
    ghosttyVariable: string;
    justBashWorkerGroups: Record<JustBashWorker, JustBashWorkerGroup>;
    libsqlRelativePath: string;
    montyRelativePath: string;
    supervisorRelativePaths: Record<BinaryTarget["key"], string>;
}

interface SourceAdapter {
    adapt: (source: string) => string;
    name: string;
    required?: boolean;
}

const TARGETS: readonly BinaryTarget[] = [
    {
        arch: "arm64",
        bunTarget: "bun-darwin-arm64",
        key: "darwin-arm64",
        platform: "darwin",
    },
    {
        arch: "x64",
        bunTarget: "bun-darwin-x64-baseline",
        key: "darwin-x64",
        platform: "darwin",
    },
    {
        arch: "arm64",
        bunTarget: "bun-linux-arm64",
        key: "linux-arm64",
        platform: "linux",
    },
    {
        arch: "x64",
        bunTarget: "bun-linux-x64-baseline",
        key: "linux-x64",
        platform: "linux",
    },
];

const SUPERVISOR_TARGETS: Record<BinaryTarget["key"], string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "linux-x64": "x86_64-unknown-linux-musl",
};

async function main(): Promise<void> {
    assertSupportedBunVersion();
    if (!existsSync(join(happyAgentRoot, "dist", "cli.js"))) {
        throw new Error("Build Happy Agent before compiling a binary (run pnpm build).");
    }
    const targets = selectTargets(process.argv.slice(2));
    await mkdir(join(happyAgentRoot, "dist", "bin"), { recursive: true });
    for (const target of targets) {
        await buildTarget(target);
    }
}

async function buildTarget(target: BinaryTarget): Promise<void> {
    const assets = resolveBinaryAssets(target);
    const adapters = resolveSourceAdapters();
    const appliedAdapters = new Set<string>();
    const outfile = join(happyAgentRoot, "dist", "bin", `happy-agent-${target.key}`);
    console.log(`Compiling ${target.key}...`);
    const result = await Bun.build({
        compile: {
            outfile,
            target: target.bunTarget,
        },
        define: {
            HAPPY_AGENT_BUILD_VERSION: JSON.stringify(
                resolveBinaryVersion(readPackageVersion(), process.env.HAPPY_AGENT_RELEASE_VERSION),
            ),
            HAPPY_AGENT_STANDALONE: "true",
        },
        entrypoints: [join(happyAgentRoot, "dist", "cli.js")],
        external: ["@mongodb-js/zstd", "cpu-features", "node-liblzma"],
        minify: true,
        plugins: [
            {
                name: "happy-agent-standalone-binary",
                setup(builder) {
                    builder.onResolve({ filter: /^happy-agent:binary-assets$/u }, () => ({
                        namespace: "happy-agent-binary-assets",
                        path: VIRTUAL_ASSETS_MODULE,
                    }));
                    builder.onLoad(
                        { filter: /.*/u, namespace: "happy-agent-binary-assets" },
                        () => ({
                            contents: renderAssetModule(assets),
                            loader: "ts",
                        }),
                    );
                    builder.onLoad({ filter: /\.[cm]?js$/u }, ({ path }) => {
                        const adapter = adapters.get(realpathIfPresent(path));
                        if (adapter === undefined) return undefined;
                        appliedAdapters.add(adapter.name);
                        return {
                            contents: adapter.adapt(readFileSync(path, "utf8")),
                            loader: "js",
                        };
                    });
                },
            },
        ],
    });
    if (!result.success) {
        for (const log of result.logs) console.error(log);
        throw new Error(`Failed to compile ${target.key}.`);
    }
    const missing = [...adapters.values()]
        .filter((adapter) => adapter.required === true && !appliedAdapters.has(adapter.name))
        .map((adapter) => adapter.name);
    if (missing.length > 0) {
        throw new Error(`The ${target.key} build did not apply adapters: ${missing.join(", ")}.`);
    }
    console.log(`Created ${outfile}`);
}

function selectTargets(arguments_: readonly string[]): readonly BinaryTarget[] {
    if (arguments_.length === 0) {
        const host = `${process.platform}-${process.arch}`;
        const target = TARGETS.find((candidate) => candidate.key === host);
        if (target === undefined) {
            throw new Error(`Happy Agent binary compilation does not support ${host}.`);
        }
        return [target];
    }
    if (arguments_.length === 1 && arguments_[0] === "--all") return TARGETS;
    let key: string | undefined;
    if (arguments_.length === 1 && arguments_[0]?.startsWith("--target=")) {
        key = arguments_[0].slice("--target=".length);
    } else if (arguments_.length === 2 && arguments_[0] === "--target") {
        key = arguments_[1];
    }
    const target = TARGETS.find((candidate) => candidate.key === key);
    if (target === undefined) {
        throw new Error(
            `Usage: bun scripts/build-binary.ts [--all | --target ${TARGETS.map((candidate) => candidate.key).join("|")}]`,
        );
    }
    return [target];
}

function assertSupportedBunVersion(): void {
    const actual = Bun.version.split(".").map((part) => Number.parseInt(part, 10));
    for (let index = 0; index < MINIMUM_BUN_VERSION.length; index += 1) {
        const current = actual[index] ?? 0;
        const minimum = MINIMUM_BUN_VERSION[index];
        if (current > minimum) return;
        if (current < minimum) {
            throw new Error(
                `Bun ${MINIMUM_BUN_VERSION.join(".")} or newer is required; found ${Bun.version}.`,
            );
        }
    }
}

function readPackageVersion(): string {
    const manifest = JSON.parse(readFileSync(join(happyAgentRoot, "package.json"), "utf8")) as {
        version?: unknown;
    };
    if (typeof manifest.version !== "string") {
        throw new Error("The Happy Agent package manifest has no version.");
    }
    return manifest.version;
}

function resolveBinaryAssets(target: BinaryTarget): BinaryAssets {
    const modulesRoot = directPackageRoot("@slopus/happy-agent-modules");
    const modulesRequire = createRequire(join(modulesRoot, "package.json"));
    const libsqlRoot = packageDependencyRoot(
        dependencyRoot("@slopus/happy-agent-modules", "@libsql/client"),
        "libsql",
    );
    const libsqlRequire = createRequire(join(libsqlRoot, "package.json"));
    const montyRoot = dependencyRoot("@slopus/happy-agent-modules", "@pydantic/monty");
    const montyRequire = createRequire(join(montyRoot, "package.json"));
    const fffRoot = dependencyRoot("@slopus/happy-agent-modules", "@ff-labs/fff-node");
    const fffRequire = createRequire(join(fffRoot, "package.json"));
    const computeRoot = dependencyRoot(
        "@slopus/happy-agent-modules",
        "@slopus/happy-agent-compute",
    );
    const computeRequire = createRequire(join(computeRoot, "package.json"));
    const providersRoot = directPackageRoot("@slopus/happy-providers");
    const providersRequire = createRequire(join(providersRoot, "package.json"));

    const nativeSuffix = target.platform === "linux" ? `${target.key}-gnu` : target.key;
    const libsqlPackage = `@libsql/${nativeSuffix}`;
    const montyPackage = `@pydantic/monty-${nativeSuffix}`;
    const ffiPackage = `@yuuang/ffi-rs-${nativeSuffix}`;
    const fffPackage = `@ff-labs/fff-bin-${nativeSuffix}`;
    const claudePackage = `@anthropic-ai/claude-agent-sdk-${target.key}`;

    const libsqlSource = resolveRequired(libsqlRequire, libsqlPackage);
    const montySource = resolveRequired(montyRequire, montyPackage);
    const ffiSource = resolveRequired(fffRequire, ffiPackage);
    const fffSource = resolveRequired(fffRequire, fffPackage);
    const claudeSource = resolveRequired(providersRequire, `${claudePackage}/claude`);
    const ghosttySource = resolveRequired(modulesRequire, "@slopus/ghostty-wasm/wasm");

    const justBashRoot = packageRootFromEntry(
        resolveRequired(computeRequire, "just-bash"),
        "just-bash",
    );
    const justBashRequire = createRequire(join(justBashRoot, "package.json"));
    const justBashChunks = join(justBashRoot, "dist", "bundle", "chunks");
    const quickjsRoot = packageRootFromEntry(
        resolveRequired(justBashRequire, "quickjs-emscripten"),
        "quickjs-emscripten",
    );
    const sqlJsRoot = packageRootFromEntry(resolveRequired(justBashRequire, "sql.js"), "sql.js");
    const quickjsModule = `import { createRequire as createQuickjsRequire } from "node:module";
const require = createQuickjsRequire(import.meta.url);
${readFileSync(join(quickjsRoot, "dist", "index.global.js"), "utf8")}
export const { getQuickJS } = QJS;
`;
    const javascriptWorker = replaceOnce(
        replaceOnce(
            readFileSync(join(justBashChunks, "js-exec-worker.js"), "utf8"),
            'import {\n  getQuickJS\n} from "quickjs-emscripten";',
            'import { getQuickJS } from "./quickjs.mjs";',
            "just-bash QuickJS worker",
        ),
        'import { stripTypeScriptTypes } from "node:module";',
        'const stripTypeScriptTypes = (source) => new Bun.Transpiler({ loader: "ts" }).transformSync(source);',
        "just-bash TypeScript transformer",
    );
    const sqliteWorker = replaceOnce(
        readFileSync(join(justBashChunks, "sqlite3-worker.js"), "utf8"),
        'import initSqlJs from "sql.js";',
        'import initSqlJs from "../../../node_modules/sql.js/dist/sql-wasm.js";',
        "just-bash SQLite worker",
    );
    const assets: EmbeddedAsset[] = [
        asset("libsqlAsset", libsqlSource, "index.node"),
        asset("montyAsset", montySource, basename(montySource)),
        asset("ffiAsset", ffiSource, basename(ffiSource)),
        asset("fffAsset", fffSource, basename(fffSource)),
        asset("claudeAsset", claudeSource, "claude", true),
        asset("ghosttyWasmAsset", ghosttySource, "ghostty-vt.wasm"),
        generatedAsset(
            "justBashJavascriptWorkerAsset",
            javascriptWorker,
            "dist/bundle/chunks/js-exec-worker.mjs",
        ),
        generatedAsset("justBashQuickjsAsset", quickjsModule, "dist/bundle/chunks/quickjs.mjs"),
        generatedAsset(
            "justBashSqliteWorkerAsset",
            sqliteWorker,
            "dist/bundle/chunks/sqlite3-worker.mjs",
        ),
        asset(
            "justBashSqlPackageAsset",
            join(sqlJsRoot, "package.json"),
            "node_modules/sql.js/package.json",
        ),
        asset(
            "justBashSqlJsAsset",
            join(sqlJsRoot, "dist", "sql-wasm.js"),
            "node_modules/sql.js/dist/sql-wasm.js",
        ),
        asset(
            "justBashSqlWasmAsset",
            join(sqlJsRoot, "dist", "sql-wasm.wasm"),
            "node_modules/sql.js/dist/sql-wasm.wasm",
        ),
    ];

    const supervisorRelativePaths = {} as Record<BinaryTarget["key"], string>;
    for (const supervisorTarget of TARGETS) {
        const alias = `@slopus/happy-agent-supervisor-${supervisorTarget.key}`;
        const manifest = resolveRequired(computeRequire, `${alias}/package.json`);
        const relativePath = `vendor/${SUPERVISOR_TARGETS[supervisorTarget.key]}/bin/happy-agent-supervisor`;
        supervisorRelativePaths[supervisorTarget.key] = relativePath;
        assets.push(
            asset(
                `supervisor${variableSuffix(supervisorTarget.key)}Asset`,
                join(dirname(manifest), relativePath),
                relativePath,
                true,
            ),
        );
    }

    return {
        assets,
        claudeRelativePath: "claude",
        fffRelativePath: basename(fffSource),
        ffiRelativePath: basename(ffiSource),
        ghosttyVariable: "ghosttyWasmAsset",
        justBashWorkerGroups: {
            javascript: {
                relativePath: "dist/bundle/chunks/js-exec-worker.mjs",
                variables: ["justBashJavascriptWorkerAsset", "justBashQuickjsAsset"],
            },
            sqlite: {
                relativePath: "dist/bundle/chunks/sqlite3-worker.mjs",
                variables: [
                    "justBashSqliteWorkerAsset",
                    "justBashSqlPackageAsset",
                    "justBashSqlJsAsset",
                    "justBashSqlWasmAsset",
                ],
            },
        },
        libsqlRelativePath: "index.node",
        montyRelativePath: basename(montySource),
        supervisorRelativePaths,
    };
}

function resolveSourceAdapters(): Map<string, SourceAdapter> {
    const adapters = new Map<string, SourceAdapter>();
    const modulesRoot = directPackageRoot("@slopus/happy-agent-modules");
    const libsqlRoot = packageDependencyRoot(
        dependencyRoot("@slopus/happy-agent-modules", "@libsql/client"),
        "libsql",
    );
    const fffRoot = dependencyRoot("@slopus/happy-agent-modules", "@ff-labs/fff-node");
    const ffiRoot = packageDependencyRoot(fffRoot, "ffi-rs");
    const computeRoot = dependencyRoot(
        "@slopus/happy-agent-modules",
        "@slopus/happy-agent-compute",
    );
    const supervisorRoot = packageDependencyRoot(computeRoot, "@slopus/happy-agent-supervisor");
    const providersRoot = directPackageRoot("@slopus/happy-providers");
    const justBashRoot = packageDependencyRoot(computeRoot, "just-bash");
    const justBashChunks = join(justBashRoot, "dist", "bundle", "chunks");

    addAdapter(
        adapters,
        join(computeRoot, "dist", "processes", "impl", "startProcessTransport.js"),
        {
            name: "Bun compute PTY transport",
            required: true,
            adapt: adaptBunComputePtyTransport,
        },
    );

    addAdapter(adapters, join(libsqlRoot, "index.js"), {
        name: "libSQL native loader",
        required: true,
        adapt: (source) =>
            replaceOnce(
                source,
                "return require(`@libsql/${target}`);",
                `return require(${JSON.stringify(VIRTUAL_ASSETS_MODULE)}).loadLibsqlNative();`,
                "libSQL native loader",
            ),
    });
    addAdapter(
        adapters,
        join(modulesRoot, "dist", "terminals", "impl", "createHostTerminalProcessFactory.js"),
        {
            name: "Bun terminal process factory",
            required: true,
            adapt: () =>
                'export { createBunTerminalProcessFactory as createHostTerminalProcessFactory } from "./createBunTerminalProcessFactory.js";\n',
        },
    );
    addAdapter(adapters, join(modulesRoot, "dist", "impl", "images", "getImageProcessor.js"), {
        name: "Bun image processor",
        required: true,
        adapt: () => `import { createBunImageProcessor } from "./createBunImageProcessor.js";
const imageProcessor = createBunImageProcessor();
export async function getImageProcessor() { return imageProcessor; }
`,
    });
    addAdapter(
        adapters,
        join(dependencyRoot("@slopus/happy-agent-modules", "@pydantic/monty"), "index.js"),
        {
            name: "Monty native loader",
            required: true,
            adapt: () => `import { loadMontyNative } from ${JSON.stringify(VIRTUAL_ASSETS_MODULE)};
const { Monty, MontyComplete, MontyException, JsMontyException, MontyNameLookup, MontyRepl, MontySnapshot, MontyTypingError, MountDir } = loadMontyNative();
export { Monty, MontyComplete, MontyException, JsMontyException, MontyNameLookup, MontyRepl, MontySnapshot, MontyTypingError, MountDir };
`,
        },
    );
    addAdapter(adapters, join(ffiRoot, "index.js"), {
        name: "ffi-rs native loader",
        required: true,
        adapt: (source) => {
            const marker = "const { DataType, createPointer";
            const markerIndex = source.indexOf(marker);
            if (markerIndex < 0) throw new Error("The ffi-rs exports changed.");
            return `const nativeBinding = require(${JSON.stringify(VIRTUAL_ASSETS_MODULE)}).loadFfiRsNative();\n${source.slice(markerIndex)}`;
        },
    });
    addAdapter(adapters, join(fffRoot, "dist", "src", "binary.js"), {
        name: "fff native library resolver",
        required: true,
        adapt: () => `import { getFffLibraryPath } from ${JSON.stringify(VIRTUAL_ASSETS_MODULE)};
export function binaryExists() { return true; }
export function findBinary() { return getFffLibraryPath(); }
`,
    });
    addAdapter(adapters, join(supervisorRoot, "dist", "impl", "resolveBinaryForTarget.js"), {
        name: "supervisor binary resolver",
        required: true,
        adapt: () => `import { existsSync } from "node:fs";
import path from "node:path";
import { getSupervisorBinary } from ${JSON.stringify(VIRTUAL_ASSETS_MODULE)};
export function resolveBinaryForTarget(key, binaryPath) {
    if (binaryPath !== undefined) {
        const explicit = path.resolve(binaryPath);
        if (!existsSync(explicit)) {
            throw new Error(\`Happy agent supervisor binary does not exist: \${explicit}\`);
        }
        return explicit;
    }
    return getSupervisorBinary(key);
}
`,
    });
    addAdapter(
        adapters,
        join(computeRoot, "dist", "supervisor", "resolveSupervisorProtectedPaths.js"),
        {
            name: "supervisor protected paths",
            required: true,
            adapt: (source) => {
                const withoutRequire = source
                    .replace('import { createRequire } from "node:module";\n', "")
                    .replace("const require = createRequire(import.meta.url);\n", "")
                    .replace(
                        '            packageRootFromEntry(require.resolve("@slopus/happy-agent-supervisor")),\n',
                        "",
                    );
                const helperStart = withoutRequire.indexOf("function packageRootFromEntry(entry)");
                const helperEnd = withoutRequire.indexOf("function packageRootFromBinary(binary)");
                if (helperStart < 0 || helperEnd < 0) {
                    throw new Error("The supervisor protected-path resolver changed.");
                }
                return withoutRequire.slice(0, helperStart) + withoutRequire.slice(helperEnd);
            },
        },
    );
    addAdapter(
        adapters,
        join(providersRoot, "dist", "vendors", "claude", "resolveClaudeCodeExecutablePath.js"),
        {
            name: "Claude executable resolver",
            required: true,
            adapt: () =>
                `import { getClaudeExecutable } from ${JSON.stringify(VIRTUAL_ASSETS_MODULE)};\nexport function resolveClaudeCodeExecutablePath() { return getClaudeExecutable(); }\n`,
        },
    );
    addAdapter(
        adapters,
        join(
            dependencyRoot("@slopus/happy-agent-modules", "@slopus/ghostty-wasm"),
            "dist",
            "load-bundled-wasm.node.js",
        ),
        {
            name: "Ghostty WASM loader",
            required: true,
            adapt: () =>
                `import { loadGhosttyWasm } from ${JSON.stringify(VIRTUAL_ASSETS_MODULE)};\nexport async function loadBundledWasm() { return loadGhosttyWasm(); }\n`,
        },
    );
    addPermissionPromptAdapter(adapters, modulesRoot);
    addAdapter(adapters, onlyMatchingFile(justBashChunks, /^js-exec-[A-Z0-9]+\.js$/u), {
        name: "just-bash JavaScript worker resolver",
        required: true,
        adapt: (source) => adaptJustBashWorkerUrl(source, "js-exec-worker.js", "javascript"),
    });
    addAdapter(adapters, onlyFileContaining(justBashChunks, "sqlite3 worker not found."), {
        name: "just-bash SQLite worker resolver",
        required: true,
        adapt: adaptJustBashSqliteChunk,
    });
    return adapters;
}

function adaptBunComputePtyTransport(source: string): string {
    const helper = join(happyAgentRoot, "dist", "binary", "startBunPtyProcessTransport.js");
    const imported = replaceOnce(
        source,
        'import { spawn as spawnPty } from "@lydell/node-pty";\n',
        `import { startBunPtyProcessTransport } from ${JSON.stringify(helper)};\n`,
        "compute PTY import",
    );
    const start = imported.indexOf("function startPtyTransport(");
    const next = imported.indexOf("function toPtyInput(", start);
    const shell = imported.indexOf("function shellArgs(", next);
    if (start < 0 || next < 0 || shell < 0) {
        throw new Error("The compute PTY transport source changed.");
    }
    return (
        imported.slice(0, start) +
        `function startPtyTransport(executable, args, options) {\n    return startBunPtyProcessTransport(executable, args, options);\n}\n` +
        imported.slice(shell)
    );
}

function renderAssetModule(binaryAssets: BinaryAssets): string {
    const imports = binaryAssets.assets
        .flatMap(({ source, variable }) =>
            source === undefined
                ? []
                : [`import ${variable} from ${JSON.stringify(source)} with { type: "file" };`],
        )
        .join("\n");
    const files = (variables: readonly string[]) => {
        const rendered = variables.map((variable) => {
            const candidate = binaryAssets.assets.find((asset) => asset.variable === variable);
            if (candidate === undefined) throw new Error(`Unknown embedded asset: ${variable}`);
            const contents =
                candidate.source === undefined
                    ? `contents: ${JSON.stringify(candidate.contents)}`
                    : `source: ${variable}`;
            return `{ ${contents}, relativePath: ${JSON.stringify(candidate.relativePath)}, executable: ${candidate.executable === true} }`;
        });
        return `[${rendered.join(", ")}]`;
    };
    const supervisorCases = TARGETS.map((target) => {
        const variable = `supervisor${variableSuffix(target.key)}Asset`;
        const relativePath = binaryAssets.supervisorRelativePaths[target.key];
        return `case ${JSON.stringify(target.key)}: return join(materializeEmbeddedFiles("supervisor-${target.key}", ${files([variable])}), ${JSON.stringify(relativePath)});`;
    }).join("\n        ");
    const justBashWorkerCases = Object.entries(binaryAssets.justBashWorkerGroups)
        .map(
            ([kind, group]) =>
                `case ${JSON.stringify(kind)}: { const root = materializeEmbeddedFiles("just-bash-${kind}", ${files(group.variables)}); return { path: join(root, ${JSON.stringify(group.relativePath)}), root }; }`,
        )
        .join("\n        ");
    return `${imports}
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { materializeEmbeddedFiles } from ${JSON.stringify(join(happyAgentRoot, "scripts", "embeddedAssetRuntime.ts"))};

const require = createRequire(import.meta.url);
const loaded = new Map();
function loadNative(name, files, relativePath) {
    const cached = loaded.get(name);
    if (cached !== undefined) return cached;
    const value = require(join(materializeEmbeddedFiles(name, files), relativePath));
    loaded.set(name, value);
    return value;
}
export function loadLibsqlNative() {
    return loadNative("libsql", ${files(["libsqlAsset"])}, ${JSON.stringify(binaryAssets.libsqlRelativePath)});
}
export function loadMontyNative() {
    return loadNative("monty", ${files(["montyAsset"])}, ${JSON.stringify(binaryAssets.montyRelativePath)});
}
export function loadFfiRsNative() {
    return loadNative("ffi-rs", ${files(["ffiAsset"])}, ${JSON.stringify(binaryAssets.ffiRelativePath)});
}
export function getFffLibraryPath() {
    return join(materializeEmbeddedFiles("fff", ${files(["fffAsset"])}), ${JSON.stringify(binaryAssets.fffRelativePath)});
}
export function getSupervisorBinary(key) {
    switch (key) {
        ${supervisorCases}
        default: throw new Error(\`Unsupported supervisor target: \${key}\`);
    }
}
export function getClaudeExecutable() {
    return join(materializeEmbeddedFiles("claude", ${files(["claudeAsset"])}), ${JSON.stringify(binaryAssets.claudeRelativePath)});
}
export function loadGhosttyWasm() {
    return Uint8Array.from(readFileSync(${binaryAssets.ghosttyVariable})).buffer;
}
function justBashWorker(kind) {
    switch (kind) {
        ${justBashWorkerCases}
        default: throw new Error(\`Unsupported just-bash worker: \${kind}\`);
    }
}
export function getJustBashWorker(kind) {
    return justBashWorker(kind).path;
}
export function loadJustBashSqlJs() {
    const cached = loaded.get("just-bash-sql-js");
    if (cached !== undefined) return cached;
    const value = require(join(justBashWorker("sqlite").root, "node_modules/sql.js/dist/sql-wasm.js"));
    loaded.set("just-bash-sql-js", value);
    return value;
}
`;
}

function asset(
    variable: string,
    source: string,
    relativePath: string,
    executable = false,
): EmbeddedAsset {
    if (!existsSync(source)) throw new Error(`Required binary asset is missing: ${source}`);
    return { executable, relativePath, source: realpathSync(source), variable };
}

function generatedAsset(variable: string, contents: string, relativePath: string): EmbeddedAsset {
    return { contents, relativePath, variable };
}

function addAdapter(
    adapters: Map<string, SourceAdapter>,
    path: string,
    adapter: SourceAdapter,
): void {
    if (!existsSync(path)) throw new Error(`Required binary adapter source is missing: ${path}`);
    adapters.set(realpathSync(path), adapter);
}

function addPermissionPromptAdapter(
    adapters: Map<string, SourceAdapter>,
    modulesRoot: string,
): void {
    const promptsRoot = join(modulesRoot, "dist", "auto", "prompts");
    const declarations =
        'const policyTemplate = readFileSync(new URL("../prompts/guardian-policy-template.md", import.meta.url), "utf8");\n' +
        'const policy = readFileSync(new URL("../prompts/guardian-policy.md", import.meta.url), "utf8");';
    const policyTemplate = readFileSync(join(promptsRoot, "guardian-policy-template.md"), "utf8");
    const policy = readFileSync(join(promptsRoot, "guardian-policy.md"), "utf8");

    addAdapter(
        adapters,
        join(modulesRoot, "dist", "auto", "impl", "createPermissionReviewInstructions.js"),
        {
            name: "permission review prompts",
            required: true,
            adapt: (source) =>
                replaceOnce(
                    replaceOnce(
                        source,
                        'import { readFileSync } from "node:fs";\n',
                        "",
                        "permission review file import",
                    ),
                    declarations,
                    `const policyTemplate = ${JSON.stringify(policyTemplate)};\nconst policy = ${JSON.stringify(policy)};`,
                    "permission review prompt declarations",
                ),
        },
    );
}

function directPackageRoot(name: string): string {
    const path = join(happyAgentRoot, "node_modules", ...name.split("/"));
    if (!existsSync(path)) throw new Error(`Happy Agent dependency is missing: ${name}`);
    return realpathSync(path);
}

function dependencyRoot(owner: string, dependency: string): string {
    return packageDependencyRoot(directPackageRoot(owner), dependency);
}

function packageDependencyRoot(ownerRoot: string, dependency: string): string {
    const installed = join(ownerRoot, "node_modules", ...dependency.split("/"));
    if (existsSync(installed)) return realpathSync(installed);
    const ownerRequire = createRequire(join(ownerRoot, "package.json"));
    return packageRootFromEntry(resolveRequired(ownerRequire, dependency), dependency);
}

function packageRootFromEntry(entry: string, expectedName: string): string {
    let current = dirname(realpathSync(entry));
    for (;;) {
        const manifestPath = join(current, "package.json");
        if (existsSync(manifestPath)) {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
            if (manifest.name === expectedName) return current;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    throw new Error(`Cannot locate package root for ${expectedName} from ${entry}.`);
}

function resolveRequired(require: Require, specifier: string): string {
    try {
        return realpathSync(require.resolve(specifier));
    } catch (error) {
        throw new Error(`Required binary dependency is missing: ${specifier}`, { cause: error });
    }
}

function onlyMatchingFile(directory: string, pattern: RegExp): string {
    const matches = readdirSync(directory)
        .filter((name) => pattern.test(name))
        .map((name) => join(directory, name));
    if (matches.length !== 1) {
        throw new Error(
            `Expected one file matching ${String(pattern)} in ${directory}, found ${matches.length}.`,
        );
    }
    return realpathSync(matches[0]);
}

function onlyFileContaining(directory: string, search: string): string {
    const matches = readdirSync(directory)
        .filter((name) => name.endsWith(".js"))
        .map((name) => join(directory, name))
        .filter((path) => readFileSync(path, "utf8").includes(search));
    if (matches.length !== 1) {
        throw new Error(
            `Expected one JavaScript file containing ${JSON.stringify(search)} in ${directory}, found ${matches.length}.`,
        );
    }
    return realpathSync(matches[0]);
}

function adaptJustBashWorkerUrl(
    source: string,
    workerFile: string,
    worker: JustBashWorker,
): string {
    const escaped = workerFile.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const expression = new RegExp(
        `[A-Za-z_$][\\w$]*\\(new URL\\("\\./${escaped}",import\\.meta\\.url\\)\\)`,
        "gu",
    );
    const matches = [...source.matchAll(expression)];
    if (matches.length !== 1) {
        throw new Error(`The just-bash ${worker} worker URL changed.`);
    }
    return `import { getJustBashWorker } from ${JSON.stringify(VIRTUAL_ASSETS_MODULE)};\n${source.replace(expression, `getJustBashWorker(${JSON.stringify(worker)})`)}`;
}

function adaptJustBashSqliteChunk(source: string): string {
    const importPattern = /import\s+([A-Za-z_$][\w$]*)\s+from"sql\.js";/gu;
    const importMatches = [...source.matchAll(importPattern)];
    if (importMatches.length !== 1 || importMatches[0]?.[1] === undefined) {
        throw new Error("The just-bash SQLite import changed.");
    }
    source = source.replace(importPattern, `const ${importMatches[0][1]} = loadJustBashSqlJs();`);

    const errorIndex = source.indexOf("sqlite3 worker not found.");
    const start = source.lastIndexOf("function ", errorIndex);
    const end = source.indexOf("}", errorIndex);
    const functionName =
        start < 0 ? undefined : /^function ([A-Za-z_$][\w$]*)/u.exec(source.slice(start))?.[1];
    if (errorIndex < 0 || start < 0 || end < 0 || functionName === undefined) {
        throw new Error("The just-bash SQLite worker resolver changed.");
    }
    source =
        source.slice(0, start) +
        `function ${functionName}(){return getJustBashWorker("sqlite")}` +
        source.slice(end + 1);
    return `import { getJustBashWorker, loadJustBashSqlJs } from ${JSON.stringify(VIRTUAL_ASSETS_MODULE)};\n${source}`;
}

function replaceOnce(source: string, search: string, replacement: string, label: string): string {
    const index = source.indexOf(search);
    if (index < 0 || source.indexOf(search, index + search.length) >= 0) {
        throw new Error(`The ${label} source changed.`);
    }
    return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function realpathIfPresent(path: string): string {
    return existsSync(path) ? realpathSync(path) : path;
}

function variableSuffix(key: BinaryTarget["key"]): string {
    return key
        .split("-")
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join("");
}

void main();
