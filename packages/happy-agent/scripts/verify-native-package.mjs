import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [rootArchive, platformArchive] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(rootArchive && platformArchive, "Select the npm root and host platform tarballs.");
const directory = mkdtempSync(join(tmpdir(), "happy-npm-native-"));
function run(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}
try {
    const root = join(directory, "root");
    const platform = join(directory, "platform");
    mkdirSync(root);
    mkdirSync(platform);
    run("tar", ["-xzf", rootArchive, "-C", root]);
    run("tar", ["-xzf", platformArchive, "-C", platform]);
    const manifest = JSON.parse(readFileSync(join(root, "package/package.json")));
    const native = JSON.parse(readFileSync(join(platform, "package/package.json")));
    assert.equal(manifest.name, "@slopus/happy-agent");
    assert.equal(native.name, `@slopus/happy-agent-${process.platform}-${process.arch}`);
    assert.equal(native.version, manifest.version);
    assert.equal(Object.keys(manifest.optionalDependencies).length, 5);
    assert.ok(
        Object.values(manifest.optionalDependencies).every(
            (version) => version === manifest.version,
        ),
    );
    assert.equal(manifest.bin["happy-agent"], "bin/happy-agent.cjs");
    assert.equal(manifest.dependencies, undefined);
    assert.deepEqual(
        run("tar", ["-tzf", rootArchive])
            .trim()
            .split(/\r?\n/)
            .filter((path) => path.startsWith("package/bin/")),
        ["package/bin/happy-agent.cjs"],
    );
    assert.deepEqual(
        run("tar", ["-tzf", platformArchive])
            .trim()
            .split(/\r?\n/)
            .filter((path) => path.startsWith("package/bin/")),
        [`package/bin/happy-agent${process.platform === "win32" ? ".exe" : ""}`],
    );
    const scope = join(root, "package/node_modules/@slopus");
    mkdirSync(scope, { recursive: true });
    renameSync(
        join(platform, "package"),
        join(scope, `happy-agent-${process.platform}-${process.arch}`),
    );
    const launcher = join(root, "package/bin/happy-agent.cjs");
    assert.match(run(process.execPath, [launcher, "--version"]), /^Happy Agent /);
    assert.match(run(process.execPath, [launcher, "--help"]), /start.*Start the daemon/);
    const failure = spawnSync(process.execPath, [launcher, "invalid-subcommand"], {
        encoding: "utf8",
        timeout: 30_000,
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /does not have a command/);
    console.log(
        "Verified npm package contents, exact platform versions, native resolution, command forwarding, and exit propagation.",
    );
} finally {
    rmSync(directory, { recursive: true, force: true });
}
