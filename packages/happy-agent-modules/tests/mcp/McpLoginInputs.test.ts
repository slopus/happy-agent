import { afterEach, describe, expect, it, vi } from "vitest";

import { assertMcpOAuthEndpoint, mcpOAuthFetch } from "../../sources/mcp/impl/mcpOAuthFetch.js";
import { parseMcpLoginRedirect } from "../../sources/mcp/impl/parseMcpLoginRedirect.js";

afterEach(() => vi.unstubAllGlobals());

const expected = {
    redirectUri: "http://127.0.0.1:53111/callback",
    state: "s".repeat(43),
    issuer: "https://auth.example.com",
};
const landed = `http://127.0.0.1:53111/callback?code=the-code&state=${"s".repeat(43)}`;

describe("a pasted sign-in address", () => {
    it("is read however the person pasted it", () => {
        for (const pasted of [
            landed,
            `  ${landed}\n`,
            `<${landed}>`,
            `"${landed}"`,
            landed.slice(7),
        ]) {
            expect(parseMcpLoginRedirect(pasted, expected)).toEqual({ ok: true, code: "the-code" });
        }
        expect(
            parseMcpLoginRedirect(`${landed}&iss=${encodeURIComponent(expected.issuer)}`, expected),
        ).toEqual({ ok: true, code: "the-code" });
    });

    it("is refused when it belongs to another attempt, address, or server", () => {
        const refused = (pasted: string) => {
            const parsed = parseMcpLoginRedirect(pasted, expected);
            expect(parsed.ok).toBe(false);
            return parsed.ok ? "" : parsed.reason;
        };
        expect(refused(landed.replace("s".repeat(43), "t".repeat(43)))).toContain(
            "different sign-in attempt",
        );
        expect(refused(landed.replace(/&state=[^&]+/u, ""))).toContain("different sign-in attempt");
        expect(refused(landed.replace("53111", "53112"))).toContain("not the address");
        expect(refused(landed.replace("/callback", "/elsewhere"))).toContain("not the address");
        expect(refused(landed.replace("code=the-code&", ""))).toContain("no sign-in code");
        expect(refused(`${landed}&iss=https%3A%2F%2Fevil.example`)).toContain(
            "different authorization server",
        );
        expect(refused(`${landed}&error=access_denied`)).toBe("The sign-in was declined.");
        expect(refused("")).toBe("Nothing was pasted.");
        expect(refused("not a url at all")).toBeTruthy();
    });
});

describe("the OAuth fetch for an MCP server", () => {
    const server = new URL("https://mcp.example.com/mcp");

    it("reaches only https endpoints on public addresses, except the server's own loopback host", async () => {
        await expect(
            assertMcpOAuthEndpoint(new URL("https://93.184.216.34/token"), server),
        ).resolves.toBeUndefined();
        for (const refused of [
            "http://auth.example.com/token",
            "https://10.0.0.5/token",
            "https://172.20.1.1/token",
            "https://192.168.1.1/token",
            "https://127.0.0.1/token",
            "https://169.254.169.254/latest/meta-data",
            "https://100.100.100.100/token",
            "https://[::1]/token",
            "https://[fd00:ec2::254]/token",
            "https://[fe80::1]/token",
            "https://[::ffff:10.0.0.1]/token",
            "https://localhost/token",
            "https://user:secret@auth.example.com/token",
        ]) {
            await expect(
                assertMcpOAuthEndpoint(new URL(refused), server),
                refused,
            ).rejects.toThrow();
        }
        const loopback = new URL("http://127.0.0.1:4000/mcp");
        await expect(
            assertMcpOAuthEndpoint(new URL("http://127.0.0.1:5000/token"), loopback),
        ).resolves.toBeUndefined();
        await expect(
            assertMcpOAuthEndpoint(new URL("http://localhost:5000/token"), loopback),
        ).rejects.toThrow("not https");
        // An https server's own host may be private, since the person configured it.
        await expect(
            assertMcpOAuthEndpoint(
                new URL("https://10.1.2.3/.well-known/oauth-protected-resource"),
                new URL("https://10.1.2.3/mcp"),
            ),
        ).resolves.toBeUndefined();
    });

    it("sends no configured headers, follows bounded GET redirects, and bounds the body", async () => {
        const sent: { url: string; init: RequestInit }[] = [];
        let respond: (url: string) => Response = () => new Response("{}");
        vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
            sent.push({ url: String(url), init });
            return respond(String(url));
        });
        const oauthFetch = mcpOAuthFetch(new URL("http://127.0.0.1:4000/mcp"));

        await oauthFetch("http://127.0.0.1:4000/.well-known/oauth-protected-resource", {
            headers: {
                Accept: "application/json",
                "MCP-Protocol-Version": "2025-06-18",
                "X-Api-Key": "configured-secret",
                Authorization: "Bearer configured-token",
                Cookie: "session=1",
            },
        });
        const headers = new Headers(sent[0]?.init.headers);
        expect([...headers.keys()].sort()).toEqual(["accept", "mcp-protocol-version"]);
        expect(sent[0]?.init.redirect).toBe("manual");

        sent.length = 0;
        respond = (url) =>
            url.endsWith("/first")
                ? new Response(null, { status: 302, headers: { location: "/second" } })
                : new Response('{"ok":true}');
        await expect((await oauthFetch("http://127.0.0.1:4000/first")).json()).resolves.toEqual({
            ok: true,
        });
        expect(sent.map((request) => request.url)).toEqual([
            "http://127.0.0.1:4000/first",
            "http://127.0.0.1:4000/second",
        ]);

        respond = () => new Response(null, { status: 307, headers: { location: "/again" } });
        await expect(
            oauthFetch("http://127.0.0.1:4000/token", { method: "POST", body: "code=1" }),
        ).rejects.toThrow("redirected a request");
        await expect(oauthFetch("http://127.0.0.1:4000/loop")).rejects.toThrow(
            "redirected too many times",
        );
        respond = (url) =>
            url.endsWith("/away")
                ? new Response(null, {
                      status: 302,
                      headers: { location: "http://169.254.169.254/" },
                  })
                : new Response("{}");
        await expect(oauthFetch("http://127.0.0.1:4000/away")).rejects.toThrow("not https");

        respond = () => new Response("x".repeat(300 * 1024));
        await expect(oauthFetch("http://127.0.0.1:4000/big")).rejects.toThrow("too large");
    });
});
