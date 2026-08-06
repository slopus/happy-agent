import { readPackageManifest } from "./release/readPackageManifest.js";
import { assertHappyRuntimeDependencies } from "./release/assertHappyRuntimeDependencies.js";
import { assertReleaseBumpAllowed } from "./release/assertReleaseBumpAllowed.js";
import { assertRegistryLatestMatchesManifest } from "./release/assertRegistryLatestMatchesManifest.js";
import { resolveReleasePackage } from "./release/resolveReleasePackage.js";
import { runCommand } from "./release/runCommand.js";
import { validateRelease } from "./release/validateRelease.js";

const VERSION_BUMPS = new Set([
    "major",
    "minor",
    "patch",
    "premajor",
    "preminor",
    "prepatch",
    "prerelease",
]);
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const USAGE = `Usage:
  pnpm release <version>
  pnpm release rig-connect <version>
  pnpm release happy-plugins <version>

Examples:
  pnpm release minor            a release with new features in it
  pnpm release patch            a release that only fixes things
  pnpm release 0.4.0            that same choice, spelled out
  pnpm release rig-connect patch
  pnpm release happy-plugins patch

Rig is still on 0.x, so it does not take a major release yet. Until it promises
compatibility, a minor is how a feature ships and a patch is how a fix does.`;

async function release(): Promise<void> {
    const arguments_ = process.argv.slice(2);
    const explicitPackage =
        arguments_[0] === "rig" ||
        arguments_[0] === "rig-connect" ||
        arguments_[0] === "happy-plugins";
    const releasePackage = resolveReleasePackage(explicitPackage ? arguments_.shift() : undefined);
    const releaseInput = arguments_[0];
    if (releaseInput === "--help" || releaseInput === "-h") {
        console.log(USAGE);
        return;
    }
    if (
        releaseInput === undefined ||
        arguments_.length !== 1 ||
        (!VERSION_BUMPS.has(releaseInput) && !SEMANTIC_VERSION.test(releaseInput))
    ) {
        throw new Error(USAGE);
    }

    const initialManifest = readPackageManifest(releasePackage);
    assertReleaseBumpAllowed({ currentVersion: initialManifest.version, requested: releaseInput });

    const worktreeStatus = runCommand("git", ["status", "--porcelain"], {
        captureOutput: true,
    }).stdout;
    if (worktreeStatus.length > 0) {
        throw new Error("The working tree must be clean before creating a release.");
    }

    if (releasePackage.key === "rig") assertHappyRuntimeDependencies(initialManifest);
    const tagsAtHead = runCommand("git", ["tag", "--points-at", "HEAD"], {
        captureOutput: true,
    }).stdout.split("\n");
    const releaseTag = `${releasePackage.tagPrefix}${initialManifest.version}`;
    const retryingRelease =
        releaseInput === initialManifest.version && tagsAtHead.includes(releaseTag);
    if (releaseInput === initialManifest.version && !retryingRelease) {
        throw new Error(
            `${initialManifest.name} is already version ${initialManifest.version}. Choose a newer version or a version bump.`,
        );
    }

    console.log("Checking the latest main branch...");
    runCommand("git", ["fetch", "origin", "main"]);
    const head = runCommand("git", ["rev-parse", "HEAD"], { captureOutput: true }).stdout;
    const originMain = runCommand("git", ["rev-parse", "origin/main"], {
        captureOutput: true,
    }).stdout;
    if (head !== originMain) {
        const originIsAncestor =
            runCommand("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], {
                allowFailure: true,
                captureOutput: true,
            }).status === 0;
        const commitsAhead = Number(
            runCommand("git", ["rev-list", "--count", "origin/main..HEAD"], {
                captureOutput: true,
            }).stdout,
        );
        if (!retryingRelease || !originIsAncestor || commitsAhead !== 1) {
            throw new Error(
                "HEAD must match origin/main. Update the worktree before creating a release.",
            );
        }
        console.log(`Resuming the local ${releaseTag} release commit.`);
    }
    if (releasePackage.key === "rig-connect" && !retryingRelease) {
        console.log("Checking the published rig-connect version...");
        const latest = runCommand(
            "pnpm",
            ["view", initialManifest.name, "dist-tags.latest", "--json"],
            { captureOutput: true },
        ).stdout;
        assertRegistryLatestMatchesManifest(initialManifest, latest);
    }

    console.log("Validating the release...");
    validateRelease(releasePackage);

    if (!retryingRelease) {
        console.log(`Creating the ${releaseInput} release commit and tag...`);
        runCommand("pnpm", ["version", releaseInput, "--no-git-tag-version"], {
            cwd: releasePackage.directory,
        });
        const versionedManifest = readPackageManifest(releasePackage);
        runCommand("git", ["add", releasePackage.manifestPath, "pnpm-lock.yaml"]);
        runCommand("git", [
            "commit",
            "-m",
            `${releasePackage.commitPrefix}${versionedManifest.version}`,
        ]);
        runCommand("git", ["tag", `${releasePackage.tagPrefix}${versionedManifest.version}`]);
    }

    const releaseManifest = readPackageManifest(releasePackage);
    console.log(`Previewing ${releaseManifest.name}@${releaseManifest.version}...`);
    runCommand("pnpm", ["publish", "--access", "public", "--dry-run", "--no-git-checks"], {
        cwd: releasePackage.directory,
    });

    console.log("Pushing the release commit and tag...");
    const tag = `${releasePackage.tagPrefix}${releaseManifest.version}`;
    runCommand("git", ["push", "origin", "HEAD:main", tag, "--atomic"]);
    console.log(
        `Pushed ${tag}. GitHub Actions will publish ${releaseManifest.name}@${releaseManifest.version}.`,
    );
}

try {
    await release();
} catch (error) {
    console.error(error instanceof Error ? error.message : "The release failed unexpectedly.");
    process.exitCode = 1;
}
