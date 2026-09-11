import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertWindowsSystemImports } from "./assertWindowsSystemImports.mjs";

if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("This native file-index verification requires Windows x64.");
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const binary = resolve(process.argv[2] ?? join(packageRoot, "native/target/win32-x64/fff_c.dll"));
const imports = assertWindowsSystemImports(binary);
const sdkRoot = dirname(
    await realpath(
        join(packageRoot, "../happy-agent-modules/node_modules/@ff-labs/fff-node/package.json"),
    ),
);
const sdkRequire = createRequire(join(sdkRoot, "package.json"));
const expectedVersion = JSON.parse(
    await readFile(join(packageRoot, "native/fff/source.json"), "utf8"),
).version;
assert.equal(
    JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8")).version,
    expectedVersion,
);
const fixture = await mkdtemp(join(tmpdir(), "happy-native-fff-"));
let finder;
let closeLibrary;
try {
    // Keep the actual installed SDK; adapt only its native resolver just as the
    // standalone builder does. No node_modules or running daemon is modified.
    const adapter = join(fixture, "sdk");
    await mkdir(adapter);
    for (const entry of await readdir(join(sdkRoot, "dist/src"))) {
        if (entry.endsWith(".js"))
            await copyFile(join(sdkRoot, "dist/src", entry), join(adapter, entry));
    }
    await writeFile(join(adapter, "package.json"), '{"type":"module"}');
    await writeFile(
        join(adapter, "binary.js"),
        `export function binaryExists(){return true;}\nexport function findBinary(){return ${JSON.stringify(binary)};}\n`,
    );
    const ffiPath = join(adapter, "ffi.js");
    const ffiSource = await readFile(ffiPath, "utf8");
    assert.ok(ffiSource.includes('from "ffi-rs"'));
    await writeFile(
        ffiPath,
        ffiSource.replace(
            'from "ffi-rs"',
            `from ${JSON.stringify(pathToFileURL(sdkRequire.resolve("ffi-rs")).href)}`,
        ),
    );
    const { FileFinder } = await import(pathToFileURL(join(adapter, "index.js")).href);
    ({ closeLibrary } = await import(pathToFileURL(ffiPath).href));
    const workspace = join(fixture, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    execFileSync("git", ["init", "--quiet", workspace], { windowsHide: true });
    await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
    await writeFile(join(workspace, "ignored.txt"), "IGNORED\n");
    await writeFile(join(workspace, "src", "hello-世界.txt"), "HAPPY_NATIVE_FFF_OK\n");
    await writeFile(join(workspace, "src", "main.ts"), "export const value = 42;\n");
    const value = (result) => {
        assert.equal(result.ok, true, result.error);
        return result.value;
    };
    for (let round = 0; round < 2; round++) {
        finder = value(
            FileFinder.create({
                basePath: workspace,
                disableMmapCache: true,
                disableContentIndexing: true,
                disableWatch: true,
                aiMode: true,
            }),
        );
        assert.equal(value(await finder.waitForScan(15000)), true);
        const search = value(finder.fileSearch("main.ts", { pageSize: 20 }));
        assert.ok(
            search.items.some((item) => item.relativePath.replaceAll("\\", "/") === "src/main.ts"),
        );
        const glob = value(finder.glob("**/*.txt", { pageSize: 20 }));
        assert.deepEqual(
            glob.items.map((item) => item.relativePath.replaceAll("\\", "/")),
            ["src/hello-世界.txt"],
        );
        const grep = value(finder.grep("HAPPY_NATIVE_FFF_OK", { mode: "plain" }));
        assert.ok(
            grep.items.some(
                (item) => item.lineContent === "HAPPY_NATIVE_FFF_OK" && item.lineNumber === 1,
            ),
        );
        await writeFile(join(workspace, "src", "added.txt"), "ADDED\n");
        value(finder.scanFiles());
        assert.equal(value(await finder.waitForScan(15000)), true);
        assert.ok(
            value(finder.fileSearch("added.txt")).items.some(
                (item) => item.fileName === "added.txt",
            ),
        );
        await rm(join(workspace, "src", "added.txt"));
        finder.destroy();
        assert.equal(finder.isDestroyed, true);
        finder = undefined;
    }
    closeLibrary();
    closeLibrary = undefined;
    await rename(workspace, workspace + "-closed");
    console.log(
        JSON.stringify({
            result: "PASS",
            runtime: globalThis.Bun ? "Bun " + Bun.version : "Node " + process.version,
            binarySha256: createHash("sha256")
                .update(await readFile(binary))
                .digest("hex"),
            imports,
            checks: [
                "scan",
                "Unicode",
                "fuzzy search",
                "glob",
                "gitignore",
                "grep",
                "file change",
                "destroy/reopen",
                "immediate rename",
            ],
        }),
    );
} finally {
    finder?.destroy();
    closeLibrary?.();
    assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
    assert.ok(fixture.includes("happy-native-fff-"));
    await rm(fixture, { recursive: true, force: true });
}
