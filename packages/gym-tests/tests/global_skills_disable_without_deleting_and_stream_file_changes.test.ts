import { createGym } from "@slopus/happy-terminal-gym";
import { describe, expect, it } from "vitest";

describe("installed global skill management", () => {
    it("streams file changes and disables agent access without deleting the installation", async () => {
        const gym = await createGym({
            mode: "docker",
            homeFiles: {
                ".agents/skills/review/SKILL.md":
                    "---\nname: review\ndescription: GLOBAL_REVIEW_DESCRIPTION\n---\nGLOBAL_REVIEW_INSTRUCTIONS\n",
            },
            files: { "manage-skills.mjs": CLIENT },
            inference(request, index) {
                if (index === 0) {
                    expect(request.context.systemPrompt).toContain("GLOBAL_REVIEW_DESCRIPTION");
                    return { content: [{ type: "text", text: "GLOBAL_SKILL_ENABLED" }] };
                }
                expect(request.context.systemPrompt).not.toContain("GLOBAL_REVIEW_DESCRIPTION");
                if (index === 1)
                    return {
                        content: [
                            {
                                type: "toolCall",
                                id: "read-disabled-skill",
                                name: "read_skill",
                                arguments: { name: "review" },
                            },
                        ],
                    };
                expect(JSON.stringify(request.context.messages)).toContain("Unknown skill");
                expect(JSON.stringify(request.context.messages)).not.toContain(
                    "GLOBAL_REVIEW_INSTRUCTIONS",
                );
                return { content: [{ type: "text", text: "DISABLED_SKILL_UNAVAILABLE" }] };
            },
        });
        try {
            gym.terminal.type("Check available skills.");
            gym.terminal.press("enter");
            await gym.terminal.waitForText("GLOBAL_SKILL_ENABLED", 30000);
            const result = await gym.runInContainer("node", ["manage-skills.mjs"], {
                timeoutMs: 60000,
            });
            expect(JSON.parse(result.stdout)).toEqual({
                disabled: true,
                fileEvent: true,
                retained: true,
                staleStatus: 409,
            });
            await gym.terminal.waitForText("Ask Happy Terminal to do anything");
            gym.terminal.type("Read the review skill.");
            gym.terminal.press("enter");
            await gym.terminal.waitForText("DISABLED_SKILL_UNAVAILABLE", 30000);
        } finally {
            await gym.dispose();
        }
    }, 120000);
});

const CLIENT = String.raw`
import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { request } from "node:http";
const directory = "/tmp/rig-" + process.getuid();
const socketPath = directory + "/server.sock";
const token = (await readFile(directory + "/token", "utf8")).trim();
function call(method, path, body, version) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = request({ socketPath, method, path, headers: {
            authorization: "Bearer " + token,
            ...(version === undefined ? {} : { "if-match": version }),
            ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        } }, response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => {
                const bytes = Buffer.concat(chunks);
                resolve({ status: response.statusCode, body: response.headers["content-type"]?.includes("json") ? JSON.parse(bytes) : bytes.toString() });
            });
        });
        req.on("error", reject); req.end(payload);
    });
}
const list = await call("GET", "/v0/skills");
assert.equal(list.status, 200);
const skill = list.body.skills.find(skill => skill.path === "review");
assert.ok(skill);
const url = "/v0/skills/" + skill.id;
assert.equal((await call("GET", url)).body.instructions, "GLOBAL_REVIEW_INSTRUCTIONS\n");
const disabled = await call("PATCH", url, { enabled: false, mutationId: "disable-global-review" }, skill.version);
assert.equal(disabled.status, 200);
assert.equal(disabled.body.skill.enabled, false);
const stale = await call("PATCH", url, { enabled: true }, skill.version);
assert.equal(stale.status, 409);
assert.equal((await call("GET", url + "/file?path=..%2Fprivate")).status, 400);
let finish;
const event = new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/v0/events/stream?cursor=" + encodeURIComponent(list.body.cursor), headers: { authorization: "Bearer " + token } }, response => {
        let buffered = "";
        response.setEncoding("utf8");
        response.on("data", chunk => {
            buffered += chunk;
            if (buffered.length > 512 * 1024) return reject(new Error("Event stream exceeded its bound."));
            let end;
            while ((end = buffered.indexOf("\n\n")) !== -1) {
                const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
                const data = frame.split("\n").find(line => line.startsWith("data: "));
                if (!data) continue;
                const value = JSON.parse(data.slice(6));
                if (value.type === "skills.updated" && value.payload.paths?.includes("review/guide.txt")) resolve(value);
            }
        });
        // Mutation occurs only after SSE is subscribed. No catalog read may cause the notification.
        writeFile(process.env.HOME + "/.agents/skills/review/guide.txt", "supporting file").catch(reject);
    });
    const timeout = setTimeout(() => reject(new Error("No live skill file notification arrived.")), 15000);
    finish = () => { clearTimeout(timeout); req.destroy(); };
    req.on("error", reject); req.end();
});
try { await event; } finally { finish(); }
const changed = (await call("GET", url)).body;
assert.notEqual(changed.skill.version, disabled.body.skill.version);
assert.equal(changed.skill.enabled, false);
assert.equal((await call("GET", url + "/file?path=guide.txt")).body, "supporting file");
assert.deepEqual((await call("GET", url + "/files")).body.files.map(file => file.path), ["SKILL.md", "guide.txt"]);
const installed = process.env.HOME + "/.agents/skills/review/SKILL.md";
const original = await readFile(installed, "utf8");
await writeFile(installed + ".tmp", original + "Changed instructions.\n");
await rename(installed + ".tmp", installed);
const replaced = (await call("GET", url)).body;
assert.equal(replaced.skill.id, skill.id);
assert.equal(replaced.skill.enabled, false);
assert.match(replaced.instructions, /Changed instructions/);
process.stdout.write(JSON.stringify({ disabled: true, fileEvent: true, retained: true, staleStatus: stale.status }));
`;
