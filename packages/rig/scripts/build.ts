import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { promisify } from "node:util";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);

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
    "@libsql/client",
    "@lydell/node-pty",
    "@mariozechner/clipboard",
    "@modelcontextprotocol/sdk",
    "@mongodb-js/zstd",
    "@number0/iroh",
    "@pydantic/monty",
    "@slopus/happy-providers",
    "@slopus/ghostty-wasm",
    "@vscode/ripgrep",
    "bufferutil",
    "cpu-features",
    "esbuild",
    "node-liblzma",
    "sharp",
    "ssh2",
    "supports-color",
    "utf-8-validate",
    "zod",
];

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
        "worklet-bootstrap": "sources/worklets/workletBootstrap.ts",
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
await cp("../happy-plugins/dist", "dist/plugin-sdk", { recursive: true });
await cp("../happy-worklets/dist", "dist/worklet-sdk", { recursive: true });
