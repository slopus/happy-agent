// Capture private original TypeBox data without changing the reference files.
// This runs only while generating Rust reference data; no JavaScript ships in
// the native daemon or participates in runtime configuration parsing.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function sourcePrivateSchema(url, names) {
    const require = createRequire(import.meta.url);
    const esbuild = createRequire(require.resolve("tsx"))("esbuild");
    const file = fileURLToPath(url);
    const output = await esbuild.build({
        stdin: {
            contents: `export {${names.join(",")}} from ${JSON.stringify(file)};`,
            resolveDir: process.cwd(),
            loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        plugins: [
            {
                name: "original-private-schema",
                setup(build) {
                    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) =>
                        args.path === file
                            ? {
                                  contents: `${readFileSync(file, "utf8")}\nexport {${names.join(",")}};`,
                                  loader: "ts",
                              }
                            : undefined,
                    );
                    build.onResolve({ filter: /^[^./]/ }, async (args) => {
                        if (args.path.startsWith("node:"))
                            return { path: args.path, external: true };
                        if (args.pluginData?.originalSchemaResolving) return;
                        const resolved = await build.resolve(args.path, {
                            resolveDir: args.resolveDir,
                            kind: args.kind,
                            pluginData: { originalSchemaResolving: true },
                        });
                        return resolved.errors.length
                            ? { errors: resolved.errors }
                            : { path: pathToFileURL(resolved.path).href, external: true };
                    });
                },
            },
        ],
    });
    return await import(
        `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
    );
}
