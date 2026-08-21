import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);

await rm("dist", { force: true, recursive: true });
await mkdir("dist", { recursive: true });
await execFileAsync("tsc", ["-p", "tsconfig.build.json"]);
const bundle = await build({
    banner: {
        js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
    },
    bundle: true,
    entryNames: "[name]",
    entryPoints: {
        main: "sources/main.ts",
        readPackageVersion: "sources/readPackageVersion.ts",
    },
    format: "esm",
    legalComments: "none",
    outdir: "dist",
    metafile: true,
    packages: "external",
    platform: "node",
    target: "node24",
});
await assertExternalPackagesDeclared(bundle.metafile);
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
