import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { build, type Plugin } from "esbuild";

const execFileAsync = promisify(execFile);

await rm("dist", { force: true, recursive: true });
await mkdir("dist", { recursive: true });
await execFileAsync("tsc", ["-p", "tsconfig.build.json"]);
const bundle = await build({
    alias: {
        "@slopus/happy-agent": resolve(import.meta.dirname, "../../happy-agent/sources/index.ts"),
        "@slopus/happy-agent-modules": resolve(
            import.meta.dirname,
            "../../happy-agent-modules/sources/index.ts",
        ),
        "@slopus/happy-agent-modules/transport": resolve(
            import.meta.dirname,
            "../../happy-agent-modules/sources/transport/index.ts",
        ),
    },
    banner: {
        js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
    },
    bundle: true,
    entryNames: "[name]",
    entryPoints: {
        // The Happy agent daemon CLI ships beside the Rig bundle so Rig can invoke
        // `node agent.js <command>` instead of owning any daemon boot sequence itself.
        agent: "../happy-agent/sources/cli.ts",
        main: "sources/main.ts",
        readPackageVersion: "sources/readPackageVersion.ts",
    },
    format: "esm",
    legalComments: "none",
    outdir: "dist",
    metafile: true,
    packages: "external",
    platform: "node",
    plugins: [bundleAutoPrompts()],
    target: "node24",
});
await assertExternalPackagesDeclared(bundle.metafile);
await cp("../happy-agent-modules/sources/auto/prompts", "dist/auto/prompts", { recursive: true });
await cp("../../docs", "dist/docs", { recursive: true });

async function assertExternalPackagesDeclared(metafile: {
    outputs: Record<string, { imports: { external?: boolean; path: string }[] }>;
}): Promise<void> {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
        dependencies?: Record<string, string>;
    };
    const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
    const missing = new Set<string>();
    for (const output of Object.values(metafile.outputs)) {
        for (const imported of output.imports) {
            if (imported.external !== true || imported.path.startsWith("node:")) continue;
            const dependency = packageName(imported.path);
            if (!dependencies.has(dependency)) missing.add(dependency);
        }
    }
    if (missing.size > 0) {
        throw new Error(
            `The Rig bundle imports undeclared runtime packages: ${[...missing].sort().join(", ")}.`,
        );
    }
}

function packageName(specifier: string): string {
    const [first = specifier, second] = specifier.split("/");
    return first.startsWith("@") && second !== undefined ? `${first}/${second}` : first;
}

function bundleAutoPrompts(): Plugin {
    return {
        name: "bundle-auto-prompts",
        setup(build) {
            build.onLoad(
                {
                    filter: /happy-agent-modules\/sources\/auto\/impl\/createPermissionReviewInstructions\.ts$/,
                },
                async ({ path }) => ({
                    contents: (await readFile(path, "utf8")).replaceAll(
                        "../prompts/",
                        "./auto/prompts/",
                    ),
                    loader: "ts",
                }),
            );
        },
    };
}
