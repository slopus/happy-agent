import { execFile } from "node:child_process";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { promisify } from "node:util";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);

/** The workspace packages Rig bundles from their built output rather than from their sources. */
const internalPackages = ["rig-execution", "rig-providers"];

/** When a directory tree was last written, or nothing when it does not exist. */
async function newestModifiedTime(directory: string): Promise<number | undefined> {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        return undefined;
    }
    let newest: number | undefined;
    for (const entry of entries) {
        const path = `${directory}/${entry.name}`;
        const time = entry.isDirectory()
            ? await newestModifiedTime(path)
            : (await stat(path)).mtimeMs;
        if (time !== undefined && (newest === undefined || time > newest)) newest = time;
    }
    return newest;
}
// `@mongodb-js/zstd` and `node-liblzma` are just-bash's optional xz and zstd codecs. They stay
// external so esbuild leaves just-bash's dynamic imports alone, and they are deliberately not
// installed: just-bash refuses both codecs unless a caller passes `allowNativeCodecs`, which Rig
// never does, so shipping the native addons would only add install-time downloads.
const externalPackages = [
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai/sandbox-runtime",
    "@anthropic-ai/sdk",
    "@ff-labs/fff-node",
    "@ffmpeg-installer/ffmpeg",
    "@ffprobe-installer/ffprobe",
    "@lydell/node-pty",
    "@mariozechner/clipboard",
    "@modelcontextprotocol/sdk",
    "@mongodb-js/zstd",
    "@number0/iroh",
    "@pydantic/monty",
    "@slopus/ghostty-wasm",
    "@vscode/ripgrep",
    "better-sqlite3",
    "bufferutil",
    "cpu-features",
    "node-liblzma",
    "sharp",
    "ssh2",
    "supports-color",
    "utf-8-validate",
    "zod",
];

// Rig bundles the internal packages from their built `dist`, so building Rig alone silently
// ships whatever they were last built from. That mixes two versions of an interface into one
// binary: the bundle typechecks, every suite passes, and the mismatch only appears at runtime,
// where a renamed event stops being recognised and its payload is dropped. Compare the two
// trees before bundling and say what to run instead.
for (const internalPackage of internalPackages) {
    const root = `../${internalPackage}`;
    const sources = await newestModifiedTime(`${root}/sources`);
    const built = await newestModifiedTime(`${root}/dist`);
    if (built === undefined) {
        throw new Error(
            `${internalPackage} has not been built. Run 'pnpm build' from the repository root.`,
        );
    }
    if (sources !== undefined && sources > built) {
        throw new Error(
            `${internalPackage} has changed since it was last built, so the Rig bundle would ` +
                `carry a stale copy of it. Run 'pnpm build' from the repository root.`,
        );
    }
}

await rm("dist", { force: true, recursive: true });
await mkdir("dist", { recursive: true });
await execFileAsync("tsc", ["-p", "tsconfig.build.json"]);
const result = await build({
    banner: {
        js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
    },
    bundle: true,
    entryNames: "[name]",
    entryPoints: {
        main: "sources/main.ts",
        "plugin-docker-bootstrap": "sources/plugins/pluginDockerBootstrap.ts",
        "plugin-sdk-loader": "sources/plugins/happyPluginsLoader.ts",
        readPackageVersion: "sources/readPackageVersion.ts",
    },
    external: externalPackages,
    format: "esm",
    legalComments: "none",
    metafile: true,
    outdir: "dist",
    packages: "bundle",
    platform: "node",
    target: "node20",
});
const bundledInputs = Object.keys(result.metafile.inputs);
for (const internalPackage of internalPackages) {
    if (!bundledInputs.some((input) => input.includes(`/${internalPackage}/dist/`))) {
        throw new Error(`The Rig bundle did not include ${internalPackage}.`);
    }
}
const unexpectedExternalImports = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter(
        (import_) =>
            import_.external &&
            !import_.path.startsWith("node:") &&
            !builtinModules.includes(import_.path) &&
            !externalPackages.some(
                (packageName) =>
                    import_.path === packageName || import_.path.startsWith(`${packageName}/`),
            ),
    );
if (unexpectedExternalImports.length > 0) {
    throw new Error(
        `The Rig bundle left unexpected packages external: ${unexpectedExternalImports
            .map((import_) => import_.path)
            .join(", ")}.`,
    );
}
await cp("sources/agent/skills/builtin", "dist/builtin-skills", { recursive: true });
await cp("../../docs", "dist/docs", { recursive: true });
await cp("sources/config/happy.template.toml", "dist/happy.template.toml");
await cp("sources/agent/prompt/guardian-policy-template.md", "dist/guardian-policy-template.md");
await cp("sources/agent/prompt/guardian-policy.md", "dist/guardian-policy.md");
await cp("../happy-plugins/dist", "dist/plugin-sdk", { recursive: true });
