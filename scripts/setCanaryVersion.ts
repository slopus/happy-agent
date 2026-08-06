import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { readPackageManifest } from "./release/readPackageManifest.js";
import { resolveCanaryVersion } from "./release/resolveCanaryVersion.js";
import { resolveReleasePackage } from "./release/resolveReleasePackage.js";

const releasePackage = resolveReleasePackage(process.env.RELEASE_PACKAGE);
const manifestPath = `${releasePackage.directory}package.json`;
// Read before writing: the canary follows the release this checkout is on, so the version it
// replaces is the one it has to be numbered from.
const canaryVersion = resolveCanaryVersion({
    baseVersion: readPackageManifest(releasePackage).version,
    buildNumber: process.env.CANARY_BUILD_NUMBER ?? "",
    commit: process.env.CANARY_COMMIT ?? "",
});

const contents = readFileSync(manifestPath, "utf8");
const updated = contents.replace(/"version":\s*"[^"]+"/, () => `"version": "${canaryVersion}"`);
if (updated === contents) {
    throw new Error(`Could not set the canary version in ${releasePackage.manifestPath}.`);
}
writeFileSync(manifestPath, updated);

const manifest = readPackageManifest(releasePackage);
console.log(`Set ${manifest.name} to the canary version ${canaryVersion}.`);
const githubEnvironment = process.env.GITHUB_ENV;
if (githubEnvironment !== undefined && githubEnvironment.length > 0) {
    appendFileSync(githubEnvironment, `CANARY_VERSION=${canaryVersion}\n`);
}
