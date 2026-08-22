#!/usr/bin/env node
// Compiles the macOS menu bar app the menuBar module starts.
//
// The app is a plain Swift executable rather than an application bundle: it never opens a window,
// so it needs no Info.plist, and a single file is what the Happy Agent binary can embed. Targets
// other than macOS have no menu bar to join and produce nothing at all.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MACOS_DEPLOYMENT_TARGET = "13.0";
const TARGETS = {
    "darwin-arm64": "arm64-apple-macos",
    "darwin-x64": "x86_64-apple-macos",
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(packageRoot, "sources", "menuBar", "native");

function main() {
    const requested = process.argv[2] ?? `${process.platform}-${process.arch}`;
    if (process.platform !== "darwin") {
        console.log("Skipping the Happy Agent menu bar app: it is built on macOS only.");
        return;
    }
    const target = TARGETS[requested];
    if (target === undefined) {
        console.log(`Skipping the Happy Agent menu bar app: ${requested} has no menu bar.`);
        return;
    }
    const outputRoot = join(packageRoot, "dist", "menuBar", "bin");
    mkdirSync(outputRoot, { recursive: true });
    const outfile = join(outputRoot, `happy-menu-bar-${requested}`);
    const sources = readdirSync(nativeRoot)
        .filter((name) => name.endsWith(".swift"))
        .map((name) => join(nativeRoot, name));
    const result = spawnSync(
        "swiftc",
        [
            "-swift-version",
            "5",
            "-O",
            "-target",
            `${target}${MACOS_DEPLOYMENT_TARGET}`,
            "-o",
            outfile,
            ...sources,
        ],
        { stdio: "inherit" },
    );
    if (result.error !== undefined) {
        throw new Error(`Could not run swiftc: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`swiftc failed while building the menu bar app for ${requested}.`);
    }
    console.log(`Created ${outfile}`);
}

main();
