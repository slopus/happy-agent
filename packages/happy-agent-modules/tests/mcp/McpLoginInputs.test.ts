import { describe, expect, it } from "vitest";

import { parseMcpLoginRedirect } from "../../sources/mcp/impl/parseMcpLoginRedirect.js";

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
