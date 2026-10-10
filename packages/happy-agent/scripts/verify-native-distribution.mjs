// Verifies one complete native distribution without publishing it: the five platform archives and
// npm packages, and the npm launcher package that depends on exactly them. Each platform carries
// the one executable, the same bytes in its archive and its npm package, built for its own
// operating system and processor. The Linux executables are static, the Windows executable does
// not depend on the Visual C++ runtime, and nothing names an interpreter or a shared library to
// load. Prints each executable's digest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [directoryArgument, version] = process.argv.slice(2);
assert.ok(directoryArgument && version, "Select the distribution directory and its exact version.");
const directory = resolve(directoryArgument);
const targets = {
    "darwin-arm64": { format: /^Mach-O 64-bit arm64 executable/ },
    "darwin-x64": { format: /^Mach-O 64-bit x86_64 executable/ },
    "linux-arm64": { format: /^ELF 64-bit LSB .*ARM aarch64/, machine: "AArch64" },
    "linux-x64": { format: /^ELF 64-bit LSB .*x86-64/, machine: "Advanced Micro Devices X86-64" },
    "win32-x64": { format: /^PE32\+ executable .*x86-64/ },
};

function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
}
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const binPaths = (archive) =>
    run("tar", ["-tzf", archive])
        .trim()
        .split(/\r?\n/)
        .filter((path) => path.startsWith("package/bin/"));

const files = readdirSync(directory);
const expected = [
    `slopus-happy-agent-${version}.tgz`,
    ...Object.keys(targets).flatMap((target) => [
        `happy-agent-${version}-${target}.tar.gz`,
        `happy-agent-${version}-${target}.tar.gz.sha256`,
        `slopus-happy-agent-${target}-${version}.tgz`,
    ]),
].sort();
assert.deepEqual(files.filter((file) => !file.startsWith(".")).sort(), expected);

const scratch = mkdtempSync(join(tmpdir(), "happy-native-distribution-"));
const rows = [];
try {
    const root = join(scratch, "root");
    mkdirSync(root);
    run("tar", ["-xzf", join(directory, `slopus-happy-agent-${version}.tgz`), "-C", root]);
    const manifest = JSON.parse(readFileSync(join(root, "package/package.json")));
    assert.equal(manifest.name, "@slopus/happy-agent");
    assert.equal(manifest.version, version);
    assert.equal(manifest.dependencies, undefined);
    assert.deepEqual(
        manifest.optionalDependencies,
        Object.fromEntries(
            Object.keys(targets).map((target) => [`@slopus/happy-agent-${target}`, version]),
        ),
    );
    assert.deepEqual(binPaths(join(directory, `slopus-happy-agent-${version}.tgz`)), [
        "package/bin/happy-agent.cjs",
    ]);

    for (const [target, expectation] of Object.entries(targets)) {
        const [os, cpu] = target.split("-");
        const executable = os === "win32" ? "happy-agent.exe" : "happy-agent";
        const archive = `happy-agent-${version}-${target}.tar.gz`;
        const archived = readFileSync(join(directory, `${archive}.sha256`), "utf8").trim();
        assert.match(archived, new RegExp(`^${digest(join(directory, archive))}  ${archive}$`));
        assert.deepEqual(
            run("tar", ["-tzf", join(directory, archive)])
                .trim()
                .split(/\r?\n/),
            [`happy-agent-${target}${os === "win32" ? ".exe" : ""}`],
        );

        const unpacked = join(scratch, target);
        mkdirSync(unpacked);
        run("tar", ["-xzf", join(directory, archive), "-C", unpacked]);
        const npmArchive = join(directory, `slopus-happy-agent-${target}-${version}.tgz`);
        run("tar", ["-xzf", npmArchive, "-C", unpacked]);
        const native = JSON.parse(readFileSync(join(unpacked, "package/package.json")));
        assert.equal(native.name, `@slopus/happy-agent-${target}`);
        assert.equal(native.version, version);
        assert.deepEqual(native.os, [os]);
        assert.deepEqual(native.cpu, [cpu]);
        assert.deepEqual(native.publishConfig?.executableFiles, [`bin/${executable}`]);
        assert.deepEqual(binPaths(npmArchive), [`package/bin/${executable}`]);
        if (os !== "win32") {
            const listing = run("tar", ["-tvzf", npmArchive]);
            assert.match(listing, new RegExp(`^-rwx.* package/bin/${executable}$`, "m"));
        }

        const binary = join(unpacked, "package/bin", executable);
        const sha256 = digest(binary);
        assert.equal(
            digest(join(unpacked, `happy-agent-${target}${os === "win32" ? ".exe" : ""}`)),
            sha256,
            `The ${target} archive and npm package must carry the same executable.`,
        );
        const format = run("file", ["-b", binary]).trim();
        assert.match(format, expectation.format, `${target}: ${format}`);
        if (os === "linux") {
            const header = run("readelf", ["-h", binary]);
            assert.match(header, new RegExp(`Machine:\\s+${expectation.machine}`));
            const programs = run("readelf", ["-lW", binary]);
            assert.doesNotMatch(programs, /INTERP/, `${target} names an ELF interpreter.`);
            const dynamic = run("readelf", ["-dW", binary]);
            assert.doesNotMatch(dynamic, /\(NEEDED\)/, `${target} needs a shared library.`);
        }
        if (os === "win32") {
            const bytes = readFileSync(binary).toString("latin1").toLowerCase();
            for (const runtime of [
                "vcruntime140.dll",
                "msvcp140.dll",
                "ucrtbase.dll",
                "api-ms-win-crt-",
            ]) {
                assert.ok(!bytes.includes(runtime), `${target} imports the C runtime ${runtime}.`);
            }
        }
        rows.push({ target, sha256, format });
    }
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
const table = [
    `### Native distribution ${version}`,
    "",
    "| Target | Executable SHA-256 | Format |",
    "| --- | --- | --- |",
    ...rows.map(
        ({ target, sha256, format }) =>
            `| ${target} | \`${sha256}\` | ${format.replaceAll("|", "\\|")} |`,
    ),
].join("\n");
console.log(table);
console.log(
    "Verified five platform archives and npm packages, their launcher's exact dependencies, matching executables, formats, and static linkage.",
);
