import { isAlreadyPublishedError } from "./release/isAlreadyPublishedError.js";
import { readPackageManifest } from "./release/readPackageManifest.js";
import { resolveDistributionTag } from "./release/resolveDistributionTag.js";
import { resolveReleasePackage } from "./release/resolveReleasePackage.js";
import { runCommand } from "./release/runCommand.js";

const releasePackage = resolveReleasePackage(process.env.RELEASE_PACKAGE);
const manifest = readPackageManifest(releasePackage);

const distributionTag = resolveDistributionTag({
    requestedTag: process.env.RELEASE_DIST_TAG,
    version: manifest.version,
});

console.log(`Publishing ${manifest.name}@${manifest.version} as ${distributionTag}...`);
const publishResult = runCommand(
    "pnpm",
    ["publish", "--access", "public", "--no-git-checks", "--tag", distributionTag],
    {
        allowFailure: true,
        captureOutput: true,
        cwd: releasePackage.directory,
    },
);

if (publishResult.stdout.length > 0) {
    console.log(publishResult.stdout);
}

if (publishResult.status === 0) {
    if (publishResult.stderr.length > 0) {
        console.error(publishResult.stderr);
    }
    console.log(`Published ${manifest.name}@${manifest.version} successfully.`);
} else if (isAlreadyPublishedError(publishResult.stderr)) {
    console.log(`${manifest.name}@${manifest.version} is already published.`);
} else {
    if (publishResult.stderr.length > 0) {
        console.error(publishResult.stderr);
    }
    throw new Error(`Publishing ${manifest.name}@${manifest.version} failed.`);
}
