import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceDirectory = "packages/happy-agent/native/libsql";

// Hash names as well as contents, including any future source metadata or patches.
export function nativeLibsqlCacheKey(root, compilerIdentity) {
    const hash = createHash("sha256");
    hash.update(JSON.stringify(compilerIdentity));
    function add(path) {
        const contents = readFileSync(join(root, path));
        hash.update(`\0${path}\0${contents.length}\0`);
        hash.update(contents);
    }
    function directory(path) {
        for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name, "en"),
        )) {
            const child = `${path}/${entry.name}`;
            if (entry.isDirectory()) directory(child);
            else if (entry.isFile()) add(child);
            else throw new Error(`Unsupported native cache input: ${child}`);
        }
    }
    add(".gitattributes");
    add("packages/happy-agent/scripts/build-native-libsql.mjs");
    add("scripts/release/nativeLibsqlCacheKey.mjs");
    directory(sourceDirectory);
    return `native-libsql-v1-${compilerIdentity.platform}-${compilerIdentity.arch}-${hash.digest("hex")}`;
}

function compilerIdentity() {
    if (!["darwin", "linux"].includes(process.platform)) {
        throw new Error("The native database release cache supports macOS and Linux only.");
    }
    const metadata = JSON.parse(readFileSync(join(repositoryRoot, sourceDirectory, "source.json")));
    function version(command, args) {
        const result = spawnSync(command, args, { encoding: "utf8" });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Cannot identify native compiler: ${command}`);
        return `${result.stdout}${result.stderr}`.trim();
    }
    const environment = Object.fromEntries(
        Object.entries(process.env)
            .filter(([name]) =>
                /^(CC|CXX|AR|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|MACOSX_DEPLOYMENT_TARGET|SDKROOT|CMAKE_GENERATOR)$|^(CC_|CXX_|AR_|CFLAGS_|CXXFLAGS_|CARGO_BUILD_|CARGO_TARGET_|CARGO_PROFILE_)/.test(
                    name,
                ),
            )
            .sort(([a], [b]) => a.localeCompare(b, "en")),
    );
    return {
        platform: process.platform,
        arch: process.arch,
        nodeAbi: process.versions.modules,
        image: [process.env.ImageOS, process.env.ImageVersion],
        os: version("uname", ["-srm"]),
        sdk:
            process.platform === "darwin"
                ? [version("xcodebuild", ["-version"]), version("xcrun", ["--show-sdk-version"])]
                : readFileSync("/etc/os-release", "utf8"),
        rustc: version("rustc", [`+${metadata.toolchain}`, "-vV"]),
        cargo: version("cargo", [`+${metadata.toolchain}`, "-vV"]),
        cc: version("gcc", ["--version"]),
        cxx: version("g++", ["--version"]),
        cmake: version("cmake", ["--version"]),
        make: version("make", ["--version"]),
        environment,
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(nativeLibsqlCacheKey(repositoryRoot, compilerIdentity()));
}
