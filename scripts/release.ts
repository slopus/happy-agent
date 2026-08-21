import { readPackageManifest } from "./release/readPackageManifest.js";
import { assertBundledHappyRuntimeDependencies } from "./release/assertBundledHappyRuntimeDependencies.js";
import { assertReleaseBumpAllowed } from "./release/assertReleaseBumpAllowed.js";
import { assertRegistryLatestMatchesManifest } from "./release/assertRegistryLatestMatchesManifest.js";
import { resolveReleasePackage } from "./release/resolveReleasePackage.js";
import { runCommand } from "./release/runCommand.js";
import { validateRelease } from "./release/validateRelease.js";
import { resolveReleaseVersionArguments } from "./release/resolveReleaseVersionArguments.js";

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
  pnpm release beta
  pnpm release happy-agent-base <version>
  pnpm release happy-agent-client <version>
  pnpm release happy-agent-compute <version>
  pnpm release happy-plugins <version>
  pnpm release happy-providers <version>

Examples:
  pnpm release minor            a release with new features in it
  pnpm release patch            a release that only fixes things
  pnpm release beta             the next quick beta, with typechecks but no tests
  pnpm release 0.4.0            that same choice, spelled out
  pnpm release happy-agent-base patch
  pnpm release happy-agent-client patch
  pnpm release happy-agent-compute patch
  pnpm release happy-plugins patch
  pnpm release happy-providers patch

Happy Terminal is still on 0.x, so it does not take a major release yet. Until it promises
compatibility, a minor is how a feature ships and a patch is how a fix does.`;

async function release(): Promise<void> {
    const arguments_ = process.argv.slice(2);
    const explicitPackage =
        arguments_[0] === "happy-terminal" ||
        arguments_[0] === "happy-agent-base" ||
        arguments_[0] === "happy-agent-client" ||
        arguments_[0] === "happy-agent-compute" ||
        arguments_[0] === "happy-plugins" ||
        arguments_[0] === "happy-providers";
    const releasePackage = resolveReleasePackage(explicitPackage ? arguments_.shift() : undefined);
    const releaseInput = arguments_[0];
    if (releaseInput === "--help" || releaseInput === "-h") {
        console.log(USAGE);
        return;
    }
    if (
        releaseInput === undefined ||
        arguments_.length !== 1 ||
        (releaseInput !== "beta" &&
            !VERSION_BUMPS.has(releaseInput) &&
            !SEMANTIC_VERSION.test(releaseInput))
    ) {
        throw new Error(USAGE);
    }

    const initialManifest = readPackageManifest(releasePackage);
    const versionArguments = resolveReleaseVersionArguments(initialManifest.version, releaseInput);
    if (versionArguments.beta && releasePackage.key !== "happy-terminal") {
        throw new Error("Beta releases are only available for @slopus/happy-terminal.");
    }
    assertReleaseBumpAllowed({ currentVersion: initialManifest.version, requested: releaseInput });

    const worktreeStatus = runCommand("git", ["status", "--porcelain"], {
        captureOutput: true,
    }).stdout;
    if (worktreeStatus.length > 0) {
        throw new Error("The working tree must be clean before creating a release.");
    }

    if (releasePackage.key === "happy-terminal") {
        assertBundledHappyRuntimeDependencies(initialManifest);
    }
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
    if (
        (releasePackage.key === "happy-agent-base" ||
            releasePackage.key === "happy-agent-client" ||
            releasePackage.key === "happy-providers") &&
        !retryingRelease
    ) {
        const initialRelease =
            releasePackage.key === "happy-providers" && initialManifest.version === "0.0.0";
        if (initialRelease) {
            console.log(`Preparing the first published ${releasePackage.key} version.`);
        } else {
            console.log(`Checking the published ${releasePackage.key} version...`);
            const latest = runCommand(
                "pnpm",
                ["view", initialManifest.name, "dist-tags.latest", "--json"],
                { captureOutput: true },
            ).stdout;
            const isTaggedUnpublishedVersion = (version: string): boolean => {
                const tag = `${releasePackage.tagPrefix}${version}`;
                const tagExists =
                    runCommand("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
                        allowFailure: true,
                        captureOutput: true,
                    }).status === 0;
                return (
                    tagExists &&
                    runCommand("git", ["merge-base", "--is-ancestor", tag, "HEAD"], {
                        allowFailure: true,
                        captureOutput: true,
                    }).status === 0
                );
            };
            assertRegistryLatestMatchesManifest(initialManifest, latest, {
                isTaggedUnpublishedVersion,
            });
            if (JSON.parse(latest) !== initialManifest.version) {
                console.log(
                    `Recovering after tagged releases through ${releaseTag} were not published.`,
                );
            }
        }
    }

    console.log("Validating the release...");
    validateRelease(releasePackage, { tests: !versionArguments.beta });

    if (!retryingRelease) {
        console.log(`Creating the ${releaseInput} release commit and tag...`);
        runCommand("pnpm", ["version", ...versionArguments.arguments], {
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
    runCommand(
        "pnpm",
        [
            "publish",
            "--access",
            "public",
            "--dry-run",
            "--no-git-checks",
            ...(versionArguments.beta ? ["--tag", "beta"] : []),
        ],
        { cwd: releasePackage.directory },
    );

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
