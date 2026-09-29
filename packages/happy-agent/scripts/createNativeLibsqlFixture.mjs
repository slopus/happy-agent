import { cp, copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Copy only the client, JS binding and native addon under test. Their unchanged
// dependencies stay read-only links; never overwrite a pnpm store hardlink.
export async function createNativeLibsqlFixture(nativeSource) {
    const modules = createRequire(
        new URL("../../happy-agent-modules/package.json", import.meta.url),
    );
    const clientPath = modules.resolve("@libsql/client");
    const client = createRequire(clientPath);
    const libsqlPath = client.resolve("libsql");
    const libsql = createRequire(libsqlPath);
    const key = `${process.platform}-${process.arch}`;
    const suffix =
        process.platform === "win32" ? "-msvc" : process.platform === "linux" ? "-gnu" : "";
    const nativePackage = `@libsql/${key}${suffix}`;
    const nativePath = libsql.resolve(nativePackage);
    const root = await mkdtemp(join(tmpdir(), "happy-libsql-runtime-"));
    try {
        const clientRoot = join(root, "node_modules/@libsql/client");
        const libsqlRoot = join(clientRoot, "node_modules/libsql");
        const nativeRoot = join(libsqlRoot, "node_modules", nativePackage);
        await copyPackage(dirname(dirname(clientPath)), clientRoot, ["libsql"]);
        await copyPackage(dirname(libsqlPath), libsqlRoot);
        await cp(dirname(nativePath), nativeRoot, { recursive: true });
        const selectedNative = join(nativeRoot, "index.node");
        if (nativeSource) await copyFile(nativeSource, selectedNative);
        return { root, packageJson: join(root, "package.json") };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}

async function copyPackage(source, destination, copiedDependencies = []) {
    await cp(source, destination, {
        recursive: true,
        filter: (path) => path !== join(source, "node_modules"),
    });
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    const require = createRequire(join(source, "package.json"));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
        if (copiedDependencies.includes(name)) continue;
        const dependencyRoot = require.resolve
            .paths(name)
            .map((path) => join(path, name))
            .find((path) => existsSync(join(path, "package.json")));
        if (!dependencyRoot) throw new Error(`Cannot locate dependency ${name}`);
        const link = join(destination, "node_modules", name);
        await mkdir(dirname(link), { recursive: true });
        await symlink(
            realpathSync(dependencyRoot),
            link,
            process.platform === "win32" ? "junction" : "dir",
        );
    }
}
