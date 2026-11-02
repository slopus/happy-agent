import { describe, expect, it } from "vitest";

import { happyUploadPath } from "../../sources/happy/happyUploadPath.js";

describe("happyUploadPath", () => {
    it("keeps only a bounded, portable last segment of the phone's name", () => {
        expect(happyUploadPath("m", 0, "C:\\Users\\me\\a<b>.pdf", "application/pdf")).toBe(
            ".happy-uploads/m/1-a_b_.pdf",
        );
        expect(
            happyUploadPath("m", 1, "https://store/x/photo.png?X-Signature=abc", "image/png"),
        ).toBe(".happy-uploads/m/2-photo.png");
        expect(happyUploadPath("m", 2, "data:image/png;base64,iVBORw0KGgo=", "image/png")).toBe(
            ".happy-uploads/m/3-attachment.png",
        );
        expect(happyUploadPath("m", 3, " ..\u0007 ", "text/plain")).toBe(
            ".happy-uploads/m/4-attachment.plain",
        );
        const long = happyUploadPath("m", 4, `${"é".repeat(100)}.txt`, "text/plain");
        expect(Buffer.byteLength(long.split("/").at(-1)!)).toBeLessThanOrEqual(2 + 120 + 4);
    });

    it("names a picture for its type, because file tools tell an image by its extension", () => {
        expect(happyUploadPath("m", 0, "IMG_1.HEIC", "image/jpeg")).toBe(
            ".happy-uploads/m/1-IMG_1.jpg",
        );
        expect(happyUploadPath("m", 0, "scan", "image/heic")).toBe(".happy-uploads/m/1-scan.heic");
        expect(happyUploadPath("m", 0, "notes", "application/vnd.weird+json")).toBe(
            ".happy-uploads/m/1-notes",
        );
    });
});
