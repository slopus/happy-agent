import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { constants, runInNewContext } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { artifactStandardFile } from "../../sources/artifactData/impl/artifactStandardFiles.js";

function text(route: string): string {
    const file = artifactStandardFile(route);
    if (file === undefined) throw new Error(`${route} is not served.`);
    return file.bytes.toString("utf8");
}

/** The least of a DOM that the components script needs to define and draw its elements. */
class FakeNode {
    children: FakeNode[] = [];
    readonly attributes = new Map<string, string>();
    readonly classList = { add: (name: string) => (this.className += ` ${name}`) };
    className = "";
    textContent = "";
    colSpan = 1;
    constructor(readonly localName: string) {}
    get tagName(): string {
        return this.localName.toUpperCase();
    }
    appendChild(child: FakeNode): FakeNode {
        if (child.localName === "#fragment") this.children.push(...child.children);
        else this.children.push(child);
        return child;
    }
    replaceChildren(...children: FakeNode[]): void {
        this.children = [];
        for (const child of children) this.appendChild(child);
    }
    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }
    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }
    hasAttribute(name: string): boolean {
        return this.attributes.has(name);
    }
    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }
    /** Every descendant's text, in order. */
    get text(): string {
        return this.textContent + this.children.map((child) => child.text).join("");
    }
    find(className: string): FakeNode[] {
        return [
            ...(this.className.split(" ").includes(className) ? [this] : []),
            ...this.children.flatMap((child) => child.find(className)),
        ];
    }
}

type Element = FakeNode & {
    source: unknown;
    connectedCallback(): void;
};

const folders: string[] = [];
afterEach(async () => {
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true })));
});

async function settled(element: Element): Promise<Element> {
    for (let wait = 0; element.hasAttribute("aria-busy") && wait < 200; wait++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    return element;
}

/**
 * Runs components.js on a fake page whose host serves `code` as `/api/v1/code.js`, or serves
 * nothing there, and returns a way to draw one of its elements.
 */
async function page(code?: string, globals: Record<string, unknown> = {}) {
    const folder = await mkdtemp(join(tmpdir(), "happy-components-"));
    folders.push(folder);
    await mkdir(join(folder, "api", "v1"), { recursive: true });
    if (code !== undefined) await writeFile(join(folder, "api", "v1", "code.mjs"), code);
    const defined = new Map<string, new () => Element>();
    // The host's module is an `.mjs` here only so Node loads it as one; pages ask for `code.js`.
    const script = text("components.js").replace('"code.js"', '"code.mjs"');
    runInNewContext(
        script,
        {
            document: {
                readyState: "complete",
                currentScript: {
                    src: pathToFileURL(join(folder, "api", "v1", "components.js")).href,
                },
                createElement: (tag: string) => new FakeNode(tag),
                createTextNode: (value: string) =>
                    Object.assign(new FakeNode("#text"), { textContent: value }),
                createDocumentFragment: () => new FakeNode("#fragment"),
            },
            location: { href: pathToFileURL(join(folder, "index.html")).href },
            customElements: {
                get: (name: string) => defined.get(name),
                define: (name: string, element: new () => Element) => defined.set(name, element),
            },
            HTMLElement: class extends FakeNode {
                constructor() {
                    super("element");
                }
            },
            URL,
            Promise,
            ...globals,
        },
        { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    );
    return {
        defined,
        /**
         * Draws an element with these attributes, showing `source` or else a `<script>` child of
         * the type given, once it has settled.
         */
        async draw(
            tag: string,
            attributes: Record<string, string>,
            source: string,
            inline?: string,
        ) {
            const element = new (defined.get(tag)!)();
            (element as { localName: string }).localName = tag;
            for (const [name, value] of Object.entries(attributes))
                element.setAttribute(name, value);
            if (inline === undefined) element.source = source;
            else {
                const child = Object.assign(new FakeNode("script"), { textContent: source });
                child.setAttribute("type", inline);
                element.appendChild(child);
            }
            element.connectedCallback();
            return await settled(element);
        },
    };
}

const CHANGES = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@ import stuff
 import { a } from "./a";
-const x = 1;
+const x = 2;
+const y = 3;
 export {};
@@ -40,4 +41,5 @@ function g() {
 function g() {
   const total = 1;
-  return total;
+  log(total);
+  return total;
 }
diff --git a/notes.md b/notes.md
new file mode 100644
--- /dev/null
+++ b/notes.md
@@ -0,0 +1,2 @@
+# Notes
+Hello
`;

/** A host renderer that records what it is asked to draw and when it is released. */
const HOST = `
export const version = 1;
const calls = (globalThis.hostCalls = []);
function draw(kind) {
    return (target, input) => {
        calls.push({ kind, input });
        target.textContent = kind + " " + (input.path ?? input.name);
        return { dispose: () => calls.push({ kind: "dispose", input: input.path ?? input.name }) };
    };
}
export const renderDiff = draw("renderDiff");
export const renderCode = draw("renderCode");
`;

type HostCall = { kind: string; input: unknown };

describe("standard files", () => {
    it("serves the components with <happy-code>, and no code renderer of the daemon's own", () => {
        const script = text("components.js");
        for (const tag of [
            "happy-diff",
            "happy-code",
            "happy-files",
            "happy-chart",
            "happy-diagram",
        ])
            expect(script).toContain(`customElements.define("${tag}"`);
        expect(script).toContain('import(BASE + "code.js")');
        expect(artifactStandardFile("code.js")).toBeUndefined();

        const style = text("style.css");
        expect(style).toContain(":where(happy-diff, happy-code) diffs-container");
        expect(style).toContain("--diffs-addition-color: var(--happy-diff-added)");
        expect(style).toContain(
            "--happy-diff-removed: var(--happy-host-diff-removed, light-dark(#d73a49, #f85149))",
        );
    });

    it("takes every page value from the host first, and insets the body by the host's inset", () => {
        const style = text("style.css");
        const root = /:where\(:root\) \{\n([^}]*)\}/.exec(style)?.[1] ?? "";
        const tokens = [...root.matchAll(/^ {4}--happy-([a-z0-9-]+): (.*);$/gm)];
        expect(tokens.map(([, name]) => name)).toEqual([
            "text",
            "muted",
            "faint",
            "border",
            "surface",
            "accent",
            "added",
            "removed",
            "diff-added",
            "diff-removed",
            "chart-1",
            "chart-2",
            "chart-3",
            "chart-4",
            "chart-5",
            "chart-6",
            "scrollbar-thumb",
            "scrollbar-thumb-hover",
            "scrollbar-size",
            "font",
            "mono",
            "font-size",
            "line-height",
            "page-inset",
        ]);
        for (const [, name, value] of tokens)
            expect(value).toMatch(new RegExp(`^var\\(--happy-host-${name}, .+\\)$`));
        expect(root).toContain("color-scheme: var(--happy-host-color-scheme, light dark);");
        expect(style).toContain("--happy-page-inset: var(--happy-host-page-inset, 24px);");
        // A host may insert the sheet at user origin, where !important would beat the page.
        expect(style).not.toContain("!important");
        expect(style).not.toContain("url(");
        expect(style).toMatch(/:where\(body\) \{[^}]*padding: var\(--happy-page-inset\);/);
    });

    it("styles scrollbars like the app's at the least specificity, from the scrollbar values", () => {
        const style = text("style.css");
        expect(style).toMatch(
            /:where\(\*\)::-webkit-scrollbar \{[^}]*width: var\(--happy-scrollbar-size\);/,
        );
        expect(style).toMatch(
            /:where\(\*\)::-webkit-scrollbar-thumb \{[^}]*background: var\(--happy-scrollbar-thumb\)/,
        );
        expect(style).toMatch(
            /::-webkit-scrollbar-thumb:hover,[^{]*\{[^}]*var\(--happy-scrollbar-thumb-hover\)/,
        );
        expect(style).toMatch(
            /@supports not selector\(::-webkit-scrollbar\) \{\s*:where\(\*\) \{[^}]*scrollbar-color: var\(--happy-scrollbar-thumb\) transparent;/,
        );
    });

    it("hands the host's renderer each file of a diff as the hunks it shows, and code as written", async () => {
        const { defined, draw } = await page(HOST);
        expect([...defined.keys()]).toEqual([
            "happy-diff",
            "happy-code",
            "happy-files",
            "happy-chart",
            "happy-diagram",
        ]);
        const calls = () => (globalThis as { hostCalls?: HostCall[] }).hostCalls!;

        const diff = await draw("happy-diff", {}, CHANGES);
        expect(diff.children.map((section) => section.getAttribute("data-path"))).toEqual([
            "src/app.ts",
            "notes.md",
        ]);
        expect(diff.text).toBe("renderDiff src/app.tsrenderDiff notes.md");
        expect(calls().map(({ input }) => input)).toEqual([
            {
                patch: [
                    "diff --git a/src/app.ts b/src/app.ts",
                    "--- a/src/app.ts",
                    "+++ b/src/app.ts",
                    "@@ -1,3 +1,4 @@ import stuff",
                    ' import { a } from "./a";',
                    "-const x = 1;",
                    "+const x = 2;",
                    "+const y = 3;",
                    " export {};",
                    "@@ -40,4 +41,5 @@ function g() {",
                    " function g() {",
                    "   const total = 1;",
                    "-  return total;",
                    "+  log(total);",
                    "+  return total;",
                    " }",
                    "",
                ].join("\n"),
                path: "src/app.ts",
                previousPath: null,
                status: "modified",
                wrap: true,
            },
            {
                patch: [
                    "diff --git a/notes.md b/notes.md",
                    "new file mode 100644",
                    "--- /dev/null",
                    "+++ b/notes.md",
                    "@@ -0,0 +1,2 @@",
                    "+# Notes",
                    "+Hello",
                    "",
                ].join("\n"),
                path: "notes.md",
                previousPath: null,
                status: "added",
                wrap: true,
            },
        ]);

        // One file, and only its lines 43-44: the hunk is cut down and its header says so. What
        // was drawn before is released first.
        calls().length = 0;
        diff.setAttribute("path", "src/app.ts");
        diff.setAttribute("lines", "43-44");
        diff.setAttribute("nowrap", "");
        diff.source = CHANGES;
        await settled(diff);
        expect(calls().map(({ kind }) => kind)).toEqual(["dispose", "dispose", "renderDiff"]);
        expect(calls()[2]!.input).toMatchObject({
            patch: [
                "diff --git a/src/app.ts b/src/app.ts",
                "--- a/src/app.ts",
                "+++ b/src/app.ts",
                "@@ -42,1 +43,2 @@ function g() {",
                "-  return total;",
                "+  log(total);",
                "+  return total;",
                "",
            ].join("\n"),
            wrap: false,
        });

        calls().length = 0;
        await draw(
            "happy-code",
            { path: "src/greet.py", lines: "2-9" },
            "\n        def greet(name):\n            return name\n    ",
            "text/plain",
        );
        expect(calls()).toEqual([
            {
                kind: "renderCode",
                input: {
                    code: "def greet(name):\n    return name",
                    path: "src/greet.py",
                    name: "src/greet.py",
                    language: null,
                    lines: { first: 2, last: 2 },
                    lineNumbers: true,
                    wrap: true,
                },
            },
        ]);
    });

    it("draws plain numbered lines where the host has no renderer", async () => {
        const { draw } = await page();
        const diff = await draw("happy-diff", { path: "src/app.ts", lines: "43-44" }, CHANGES);
        const rows = diff.find("happy-lines")[0]!.children[0]!.children;
        expect(rows.map((row) => [row.className, row.children.map((cell) => cell.text)])).toEqual([
            ["happy-line-del", ["42", "", "−  return total;"]],
            ["happy-line-add", ["", "43", "+  log(total);"]],
            ["happy-line-add", ["", "44", "+  return total;"]],
        ]);
        expect(diff.find("happy-code-header")[0]!.text).toBe("src/app.ts+2 −1");

        const fullDiff = await draw("happy-diff", { path: "src/app.ts" }, CHANGES);
        const fullRows = fullDiff.find("happy-lines")[0]!.children[0]!.children;
        expect(
            fullRows.filter((row) => row.className === "happy-line-gap").map((row) => row.text),
        ).toEqual(["⋯"]);

        const code = await draw("happy-code", {}, "\n    a = 1\n    b = 2\n", "text/plain");
        expect(
            code
                .find("happy-lines")[0]!
                .children[0]!.children.map((row) => row.children.map((cell) => cell.text)),
        ).toEqual([["a = 1"], ["b = 2"]]);
    });

    it("tells the artifact's log what an element could not show, with what it could", async () => {
        const posts: {
            url: string;
            body: { entries: { level: string; source: string; message: string }[] };
        }[] = [];
        const fetch = async (url: string, init?: { method?: string; body?: string }) => {
            if (init?.method !== "POST") throw new Error(`unexpected fetch of ${url}`);
            posts.push({ url, body: JSON.parse(init.body!) });
            return { ok: true };
        };
        const { draw } = await page(undefined, { fetch, console: { warn: () => {} } });

        const missing = await draw("happy-diff", { path: "src/gone.ts" }, CHANGES);
        expect(missing.find("happy-error")[0]!.text).toBe(
            "The diff does not change src/gone.ts. It changes src/app.ts, notes.md.",
        );
        const outside = await draw("happy-diff", { path: "src/app.ts", lines: "20-30" }, CHANGES);
        expect(outside.find("happy-diff-note")[0]!.text).toBe("No changes in lines 20–30");
        // Drawn again, the same trouble is not posted again.
        await draw("happy-diff", { path: "src/gone.ts" }, CHANGES);

        expect(posts.map((post) => post.url.replace(/^.*\/api\//, "/api/"))).toEqual([
            "/api/v1/debug/log",
            "/api/v1/debug/log",
        ]);
        expect(
            posts.map((post) =>
                post.body.entries.map(({ level, source, message }) => [level, source, message]),
            ),
        ).toEqual([
            [
                [
                    "warn",
                    "console",
                    '<happy-diff path="src/gone.ts"> The diff does not change src/gone.ts. It changes src/app.ts, notes.md.',
                ],
            ],
            [
                [
                    "warn",
                    "console",
                    '<happy-diff path="src/app.ts" lines="20-30"> No changes in lines 20–30 of src/app.ts; it changes lines 1–4, 41–45.',
                ],
            ],
        ]);
    });

    it("leaves reporting to client.js on a page that loads it, with the same message", async () => {
        let posted = 0;
        const fetch = async () => {
            posted++;
            return { ok: true };
        };
        const warnings: unknown[][] = [];
        const { draw } = await page(undefined, {
            fetch,
            console: { warn: (...args: unknown[]) => warnings.push(args) },
            happy: { debug: { log: () => {} } },
        });
        const missing = await draw("happy-diff", { path: "src/gone.ts" }, CHANGES);
        expect(missing.find("happy-error")).toHaveLength(1);
        expect(posted).toBe(0);
        expect(warnings).toEqual([
            [
                '<happy-diff path="src/gone.ts"> The diff does not change src/gone.ts. It changes src/app.ts, notes.md.',
            ],
        ]);
    });

    it("reads a diff's paths whatever prefixes git was configured to write", async () => {
        // diff.mnemonicPrefix: c/ and w/ for the work tree, 1/ and 2/ for --no-index.
        const mnemonic = [
            "diff --git c/src/app.ts w/src/app.ts",
            "index 814f4a4..99b356d 100644",
            "--- c/src/app.ts",
            "+++ w/src/app.ts",
            "@@ -1,2 +1,2 @@",
            " one",
            "-two",
            "+2",
            "diff --git c/src/old name.ts w/src/new name.ts",
            "similarity index 100%",
            "rename from src/old name.ts",
            "rename to src/new name.ts",
            "diff --git c/gone.ts w/gone.ts",
            "deleted file mode 100644",
            "--- c/gone.ts",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-bye",
            "diff --git 1/notes.md 2/notes.md",
            "new file mode 100644",
            "--- /dev/null",
            "+++ 2/notes.md",
            "@@ -0,0 +1 @@",
            "+hi",
            "",
        ].join("\n");
        // diff.noprefix: a folder named a/ is the path's own, not a prefix.
        const noPrefix = [
            "diff --git a/b.ts a/b.ts",
            "--- a/b.ts",
            "+++ a/b.ts",
            "@@ -1 +1 @@",
            "-x",
            "+y",
            "diff --git my notes.md my notes.md",
            "new file mode 100644",
            "--- /dev/null",
            "+++ my notes.md",
            "@@ -0,0 +1 @@",
            "+hi",
            "",
        ].join("\n");
        const { draw } = await page();
        const titles = (diff: Element) =>
            diff.children.map((section) => [
                section.getAttribute("data-path"),
                section.find("happy-file-title")[0]!.text,
            ]);

        expect(titles(await draw("happy-diff", {}, mnemonic))).toEqual([
            ["src/app.ts", "src/app.ts"],
            ["src/new name.ts", "src/old name.ts→src/new name.tsrenamed"],
            ["gone.ts", "gone.tsdeleted"],
            ["notes.md", "notes.mdnew"],
        ]);
        expect(titles(await draw("happy-diff", {}, noPrefix))).toEqual([
            ["a/b.ts", "a/b.ts"],
            ["my notes.md", "my notes.mdnew"],
        ]);
        const quoted = await draw("happy-diff", { path: "src/app.ts", lines: "2" }, mnemonic);
        expect(quoted.find("happy-error")).toEqual([]);
        expect(quoted.find("happy-code-header")[0]!.text).toBe("src/app.ts+1 −1");
    });
});
