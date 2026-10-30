import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { sendArtifactComponent } from "../../sources/api/ApiArtifactData.js";
import { ApiError } from "../../sources/api/ApiError.js";
import { artifactStandardFile } from "../../sources/artifactData/impl/artifactStandardFiles.js";

type Sent = { status: number; headers: Record<string, unknown>; body: Buffer | undefined };

function send(pathname: string, ifNoneMatch?: string): Sent {
    const sent: Sent = { status: 0, headers: {}, body: undefined };
    const request = {
        headers: ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch },
    } as IncomingMessage;
    const response = {
        writeHead(status: number, headers: Record<string, unknown>) {
            sent.status = status;
            sent.headers = headers;
        },
        end(body?: Buffer) {
            sent.body = body;
        },
    } as unknown as ServerResponse;
    sendArtifactComponent(request, response, pathname);
    return sent;
}

describe("standard components outside an artifact", () => {
    it("serves each standard file as every artifact's /api/v1/ does", () => {
        for (const file of ["style.css", "components.js", "diagrams.js"]) {
            const standard = artifactStandardFile(file)!;
            const sent = send(`/v0/artifact-components/${file}`);
            expect(sent.status).toBe(200);
            expect(sent.headers).toMatchObject({
                "cache-control": "no-cache",
                etag: standard.etag,
                "content-type": standard.contentType,
                "x-content-type-options": "nosniff",
            });
            expect(sent.body).toEqual(standard.bytes);
            expect(send(`/v0/artifact-components/${file}`, standard.etag).status).toBe(304);
        }
    });

    it("answers 404 for any other file, the host's code.js among them", () => {
        for (const file of ["code.js", "client.js", "me", "style.css.map", "%2E%2E"]) {
            expect(() => send(`/v0/artifact-components/${file}`)).toThrow(ApiError);
        }
    });
});
