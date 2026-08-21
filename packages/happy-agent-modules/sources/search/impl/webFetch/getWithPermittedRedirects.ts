import { createTimedSignal } from "../../../impl/createTimedSignal.js";
import { describeWebFetchFailure } from "./describeWebFetchFailure.js";
import { isPermittedWebFetchRedirect } from "./isPermittedWebFetchRedirect.js";
import { readWebFetchResponse } from "./readWebFetchResponse.js";

const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const REDIRECT_CODES = new Set([301, 302, 307, 308]);

export interface WebFetchRedirect {
    readonly type: "redirect";
    readonly originalUrl: string;
    readonly redirectUrl: string;
    readonly statusCode: number;
}

export interface WebFetchHttpResponse {
    readonly response: Response;
    readonly raw: Buffer;
}

/** Fetches one page, following redirects only while they stay on the same site. */
export async function getWithPermittedRedirects(
    url: string,
    signal?: AbortSignal,
    depth = 0,
): Promise<WebFetchHttpResponse | WebFetchRedirect> {
    if (depth > MAX_REDIRECTS) {
        throw new Error(`The page redirected more than ${String(MAX_REDIRECTS)} times.`);
    }

    const timedSignal = createTimedSignal(signal, FETCH_TIMEOUT_MS);
    try {
        let response: Response;
        try {
            response = await fetch(url, {
                headers: {
                    Accept: "text/markdown, text/html, */*",
                    "User-Agent": "Happy Agent (+https://github.com/slopus/happy-agent)",
                },
                redirect: "manual",
                signal: timedSignal.signal,
            });
        } catch (error) {
            // A caller's own cancellation is not a failure to describe; it is what they asked for.
            if (signal?.aborted === true) throw error;
            throw new Error(describeWebFetchFailure(url, error), { cause: error });
        }

        if (REDIRECT_CODES.has(response.status)) {
            const location = response.headers.get("location");
            if (location === null) {
                throw new Error("The site redirected without saying where to.");
            }
            const redirectUrl = new URL(location, url).toString();
            if (isPermittedWebFetchRedirect(url, redirectUrl)) {
                return await getWithPermittedRedirects(redirectUrl, signal, depth + 1);
            }
            return {
                type: "redirect",
                originalUrl: url,
                redirectUrl,
                statusCode: response.status,
            };
        }

        if (!response.ok) {
            const explained = response.statusText.trim();
            const host = new URL(url).hostname;
            throw new Error(
                explained.length === 0
                    ? `${host} answered with HTTP ${String(response.status)}.`
                    : `${host} answered with HTTP ${String(response.status)} ${explained}.`,
            );
        }

        return { response, raw: await readWebFetchResponse(response) };
    } finally {
        timedSignal.dispose();
    }
}
