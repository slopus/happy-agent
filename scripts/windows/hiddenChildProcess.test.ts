import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/*
 * Master plan 29: every program Happy Agent starts goes through the shared hidden-window helper,
 * so Windows never shows a console window. This scans the shipped sources and fails on any
 * other way to start a program.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));

/** The helper, copied into each package that starts programs; the copies must stay identical. */
const HELPERS = [
    "packages/happy-agent/sources/utils/hiddenChildProcess.ts",
    "packages/happy-agent-compute/sources/processes/hiddenChildProcess.ts",
    "packages/happy-agent-modules/sources/utils/hiddenChildProcess.ts",
    "packages/happy-plugins/sources/hiddenChildProcess.ts",
    "packages/happy-providers/sources/core/hiddenChildProcess.ts",
];

/**
 * Programs started under a pseudo-terminal. ConPTY attaches them to a console that has no
 * window, and `windowsHide` asks Windows not to give them a console at all, which would cut them
 * off from the terminal.
 */
const PSEUDO_TERMINALS = [
    "packages/happy-agent-compute/sources/host/impl/startHostProcessSource.ts",
    "packages/happy-agent-compute/sources/processes/impl/startProcessTransport.ts",
    "packages/happy-agent/sources/binary/startBunPtyProcessTransport.ts",
];

/** The gym packages are the test harness and never ship. */
const SKIPPED_PACKAGES = new Set(["happy-agent-gym", "happy-agent-gym-tests"]);

const PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const PTY_MODULES = new Set(["node-pty", "@lydell/node-pty"]);

test("every program is started through the hidden-window helper", () => {
    const violations = shippedSources().flatMap((path) => {
        const name = relative(root, path).replaceAll("\\", "/");
        if (HELPERS.includes(name)) return [];
        return findLaunches(path, PSEUDO_TERMINALS.includes(name)).map(
            (finding) => `${name}:${finding}`,
        );
    });
    assert.deepEqual(
        violations,
        [],
        "Start programs with spawnHidden, spawnSyncHidden, execFileHidden, or execFileSyncHidden " +
            "from the package's hiddenChildProcess.ts so Windows never shows a console window. " +
            "See master-plans/29-windows.md.",
    );
});

test("every copy of the helper is identical", () => {
    const [first, ...others] = HELPERS.map((path) => readFileSync(join(root, path), "utf8"));
    for (const [index, other] of others.entries()) {
        assert.equal(other, first, `${HELPERS[index + 1]} differs from ${HELPERS[0]}`);
    }
});

test("the scan reports every way around the helper", () => {
    const source = [
        'import { spawn } from "node:child_process";',
        'import * as processes from "child_process";',
        'import { type ChildProcess, execFile } from "node:child_process";',
        'import type { SpawnOptions } from "node:child_process";',
        'import { spawn as spawnPty } from "@lydell/node-pty";',
        'export { fork } from "node:child_process";',
        'const required = require("child_process");',
        'const loaded = await import("node:child_process");',
        'Bun.spawn(["git"], {});',
        'bun.spawnSync(["git"]);',
        'spawnHidden("git", [], { windowsHide: false });',
    ].join("\n");
    assert.deepEqual(scan(source, false), [
        "1 imports node:child_process",
        "2 imports child_process",
        "3 imports node:child_process",
        "5 imports @lydell/node-pty",
        "6 imports node:child_process",
        "7 imports child_process",
        "8 imports node:child_process",
        "9 starts a program with Bun.spawn",
        "10 starts a program with Bun.spawnSync",
        "11 sets windowsHide, which only the helper sets",
    ]);
    assert.deepEqual(scan(source, true), [
        "1 imports node:child_process",
        "2 imports child_process",
        "3 imports node:child_process",
        "6 imports node:child_process",
        "7 imports child_process",
        "8 imports node:child_process",
        "11 sets windowsHide, which only the helper sets",
    ]);
});

function shippedSources(): string[] {
    const packages = join(root, "packages");
    return readdirSync(packages, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !SKIPPED_PACKAGES.has(entry.name))
        .flatMap((entry) => sourceFiles(join(packages, entry.name, "sources")));
}

function sourceFiles(directory: string): string[] {
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries.flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === "tests" ? [] : sourceFiles(path);
        if (!/\.(?:[cm]?[jt]sx?)$/u.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
        return /\.(?:test|spec)\.[^.]+$/u.test(entry.name) ? [] : [path];
    });
}

function findLaunches(path: string, pseudoTerminal: boolean): string[] {
    return scan(readFileSync(path, "utf8"), pseudoTerminal);
}

/** Findings as `line message`; a pseudo-terminal file may start its terminal program directly. */
function scan(text: string, pseudoTerminal: boolean): string[] {
    const file = ts.createSourceFile("source.ts", text, ts.ScriptTarget.Latest, true);
    const findings: string[] = [];
    const report = (node: ts.Node, message: string) => {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        findings.push(`${String(line)} ${message}`);
    };
    const imported = (node: ts.Node, specifier: ts.Expression | undefined) => {
        if (specifier === undefined || !ts.isStringLiteral(specifier)) return;
        if (PROCESS_MODULES.has(specifier.text)) report(node, `imports ${specifier.text}`);
        if (PTY_MODULES.has(specifier.text) && !pseudoTerminal) {
            report(node, `imports ${specifier.text}`);
        }
    };
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && !typeOnly(node)) {
            imported(node, node.moduleSpecifier);
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
            imported(node, node.moduleSpecifier);
        } else if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (
                callee.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(callee) && callee.text === "require")
            ) {
                imported(node, node.arguments[0]);
            } else if (
                ts.isPropertyAccessExpression(callee) &&
                ts.isIdentifier(callee.expression) &&
                /^[Bb]un$/u.test(callee.expression.text) &&
                /^spawn(?:Sync)?$/u.test(callee.name.text) &&
                !pseudoTerminal
            ) {
                report(node, `starts a program with Bun.${callee.name.text}`);
            }
        } else if (
            (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
            node.name.getText(file) === "windowsHide"
        ) {
            report(node, "sets windowsHide, which only the helper sets");
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return findings;
}

function typeOnly(node: ts.ImportDeclaration): boolean {
    const clause = node.importClause;
    if (clause === undefined) return false;
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    return (
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly)
    );
}
