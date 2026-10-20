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
async function page(code?: string) {
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
        expect(style).toContain("--happy-diff-removed: light-dark(#d73a49, #f85149)");
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
            ["happy-line-gap", ["function g() {"]],
            ["happy-line-del", ["42", "", "−  return total;"]],
            ["happy-line-add", ["", "43", "+  log(total);"]],
            ["happy-line-add", ["", "44", "+  return total;"]],
        ]);
        expect(diff.find("happy-code-header")[0]!.text).toBe("src/app.ts+2 −1");

        const code = await draw("happy-code", {}, "\n    a = 1\n    b = 2\n", "text/plain");
        expect(
            code
                .find("happy-lines")[0]!
                .children[0]!.children.map((row) => row.children.map((cell) => cell.text)),
        ).toEqual([["a = 1"], ["b = 2"]]);
    });
});
