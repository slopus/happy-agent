import {
    createAgentGym,
    createUnixSocketFetch,
    type AgentGym,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** A gym whose model makes exactly the tool call a scenario asks for. */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        inference: (request) => {
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Log work settled." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function call(name: string, args: Record<string, unknown>) {
        const agentId = gym.defaultSessionId;
        const callId = `components_test_${String(++callIndex)}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please execute ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "read_only",
        });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
    }
    return { gym, call };
}

/** The least of a DOM that the components script needs to define and draw a diff. */
class FakeNode {
    children: FakeNode[] = [];
    readonly attributes = new Map<string, string>();
    readonly classList = { add: (name: string) => (this.className += ` ${name}`) };
    className = "";
    textContent = "";
    colSpan = 1;
    constructor(public localName: string) {}
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
    get text(): string {
        return this.textContent + this.children.map((child) => child.text).join("");
    }
}

type FakeElement = FakeNode & { connectedCallback(): void };

/**
 * A review page without the SDK: the daemon's own `components.js` evaluated on a fake DOM whose
 * `fetch` reaches the artifact's files and API with the token added, as a desktop client does. The
 * script's own address names no host renderer, so diffs are drawn plainly.
 */
async function openReviewPage(gym: AgentGym, artifactId: string) {
    const socketFetch = createUnixSocketFetch(gym.socketPath);
    const requests: string[] = [];
    const pageFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
        const url = new URL(input);
        const path =
            url.protocol === "file:"
                ? `/v0/artifacts/${artifactId}${url.pathname.slice(url.pathname.indexOf("/api/"))}`
                : url.pathname;
        requests.push(`${init.method ?? "GET"} ${path}`);
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${gym.token}`);
        return await socketFetch(`http://daemon${path}`, { ...init, headers });
    };
    const script = await (await pageFetch(`file:///happy-gym-page/api/v1/components.js`)).text();
    const defined = new Map<string, new () => FakeElement>();
    const window = {
        document: {
            readyState: "complete",
            currentScript: { src: "file:///happy-gym-page/api/v1/components.js" },
            createElement: (tag: string) => new FakeNode(tag),
            createTextNode: (value: string) =>
                Object.assign(new FakeNode("#text"), { textContent: value }),
            createDocumentFragment: () => new FakeNode("#fragment"),
        },
        location: { href: gym.client.artifactFileUrl(artifactId, "latest", "index.html") },
        customElements: {
            get: (name: string) => defined.get(name),
            define: (name: string, element: new () => FakeElement) => defined.set(name, element),
        },
        console: { warn: () => {} },
        fetch: pageFetch,
    };
    const HTMLElement = class extends FakeNode {
        constructor() {
            super("element");
        }
    };
    new Function("window", "fetch", "HTMLElement", script)(window, pageFetch, HTMLElement);
    return {
        requests,
        /** Draws a `<happy-diff>` with these attributes once it has settled. */
        async diff(attributes: Record<string, string>): Promise<FakeNode> {
            const element = new (defined.get("happy-diff")!)();
            element.localName = "happy-diff";
            for (const [name, value] of Object.entries(attributes))
                element.setAttribute(name, value);
            element.connectedCallback();
            return await gym.waitUntil(
                () => (element.hasAttribute("aria-busy") ? undefined : element),
                "the diff to draw",
            );
        },
    };
}

const CHANGES = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import { a } from "./a";
-const x = 1;
+const x = 2;
+const y = 3;
 export {};
`;

describe("artifact components", () => {
    it("tell the agent's log what a review page could not show, without the SDK", async () => {
        const { gym, call } = await harness();
        const { artifact } = await gym.client.createArtifact({
            type: "html",
            title: "Review: counter",
            files: [
                {
                    path: "index.html",
                    text: '<happy-diff src="changes.diff" path="src/app.ts" lines="2-3"></happy-diff><script src="/api/v1/components.js"></script>',
                },
                { path: "changes.diff", text: CHANGES },
            ],
        });
        const page = await openReviewPage(gym, artifact.id);

        const quoted = await page.diff({ src: "changes.diff", path: "src/app.ts", lines: "2-3" });
        expect(quoted.text).toContain("const x = 2;");
        const missing = await page.diff({ src: "changes.diff", path: "src/gone.ts" });
        expect(missing.text).toBe("The diff does not change src/gone.ts. It changes src/app.ts.");
        const outside = await page.diff({
            src: "changes.diff",
            path: "src/app.ts",
            lines: "40-45",
        });
        expect(outside.text).toContain("No changes in lines 40–45");
        await gym.waitUntil(
            () =>
                page.requests.filter((request) => request.endsWith("/api/v1/debug/log")).length ===
                    2 || undefined,
            "the page's reports",
        );

        const logs = await gym.waitUntil(async () => {
            const result = await call("read_artifact_logs", { artifactId: artifact.id });
            return result.text.includes("2 entries") ? result : undefined;
        }, "the agent to read the page's reports");
        expect(logs.text).toContain(
            '<happy-diff src="changes.diff" path="src/gone.ts"> The diff does not change src/gone.ts. It changes src/app.ts.',
        );
        expect(logs.text).toContain(
            '<happy-diff src="changes.diff" path="src/app.ts" lines="40-45"> No changes in lines 40–45 of src/app.ts; it changes lines 1–4.',
        );
        expect(logs.text).toContain("warn · console");
        expect(logs.text).not.toContain("const x");
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
