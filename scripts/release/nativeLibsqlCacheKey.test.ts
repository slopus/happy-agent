import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const { nativeLibsqlCacheKey } = await import(
    new URL("./nativeLibsqlCacheKey.mjs", import.meta.url).href
);
const inputs = [
    ".gitattributes",
    "packages/happy-agent/scripts/build-native-libsql.mjs",
    "scripts/release/nativeLibsqlCacheKey.mjs",
    "packages/happy-agent/native/libsql",
];
const identity = {
    platform: "linux",
    arch: "x64",
    nodeAbi: "137",
    image: ["ubuntu24", "20261001.1"],
    os: "Linux x86_64",
    sdk: "Ubuntu 24.04",
    rustc: "rustc 1.95.0",
    cargo: "cargo 1.95.0",
    cc: "gcc 13",
    cxx: "g++ 13",
    cmake: "cmake 3.28",
    make: "GNU Make 4.3",
    environment: {},
};

test("native release cache reuses an unsigned output after a source-only repair and misses for every native input", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-release-cache-"));
    try {
        for (const input of inputs) {
            await mkdir(dirname(join(root, input)), { recursive: true });
            await cp(new URL(`../../${input}`, import.meta.url), join(root, input), {
                recursive: true,
            });
        }
        const key = nativeLibsqlCacheKey(root, identity);
        const outputs = new Map([[key, Buffer.from("verified unsigned native output")]]);
        await mkdir(join(root, "packages/happy-agent/sources/socket"), { recursive: true });
        await writeFile(
            join(root, "packages/happy-agent/sources/socket/fixture.ts"),
            "prepareLiveSocket: async () => ({ handled: false })",
        );
        assert.equal(nativeLibsqlCacheKey(root, identity), key);
        assert.deepEqual(outputs.get(nativeLibsqlCacheKey(root, identity)), outputs.get(key));

        for (const path of [
            ...inputs.slice(0, 3),
            "packages/happy-agent/native/libsql/source.json",
            "packages/happy-agent/native/libsql/binding.patch",
            "packages/happy-agent/native/libsql/connection.patch",
            "packages/happy-agent/native/libsql/Cargo.lock",
        ]) {
            const file = join(root, path);
            const original = await readFile(file);
            await writeFile(file, Buffer.concat([original, Buffer.from("\nchanged native input")]));
            const changed = nativeLibsqlCacheKey(root, identity);
            assert.notEqual(changed, key, path);
            assert.equal(outputs.has(changed), false, path);
            await writeFile(file, original);
        }
        const patch = join(root, "packages/happy-agent/native/libsql/future.patch");
        await writeFile(patch, "new native patch");
        assert.notEqual(nativeLibsqlCacheKey(root, identity), key, "new patches invalidate");
        await rm(patch);
        assert.equal(nativeLibsqlCacheKey(root, identity), key);

        for (const field of Object.keys(identity)) {
            const changed = nativeLibsqlCacheKey(root, { ...identity, [field]: "changed" });
            assert.notEqual(changed, key, field);
            assert.equal(outputs.has(changed), false, field);
        }
        assert.notEqual(
            nativeLibsqlCacheKey(root, {
                ...identity,
                environment: { RUSTFLAGS: "-C opt-level=1" },
            }),
            key,
        );
        await rm(join(root, "packages/happy-agent/native/libsql/Cargo.lock"));
        assert.notEqual(nativeLibsqlCacheKey(root, identity), key, "removed inputs invalidate");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
