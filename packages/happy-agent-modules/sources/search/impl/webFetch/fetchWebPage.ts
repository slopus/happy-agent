import type { FetchInput, FetchResult } from "../../Search.js";

import { getTurndownService } from "./getTurndownService.js";
import { getWithPermittedRedirects } from "./getWithPermittedRedirects.js";
import { isBinaryContentType } from "./isBinaryContentType.js";
import { validateWebFetchUrl } from "./validateWebFetchUrl.js";

/**
 * Fetches one public page and returns it as text the model can read.
 *
 * HTML becomes markdown, other text is passed through as it arrived, and bytes that are not text
 * at all are reported rather than decoded into noise. A redirect off the site is reported too,
 * so following it stays a deliberate second call.
 */
export async function fetchWebPage(input: FetchInput): Promise<FetchResult> {
    if (!validateWebFetchUrl(input.url)) {
        throw new Error(`${input.url} is not a public web address Happy Agent can fetch.`);
    }
    const response = await getWithPermittedRedirects(input.url);
    if ("type" in response) {
        return {
            url: input.url,
            content: `This page redirects to ${response.redirectUrl}. Fetch that address to continue.`,
            truncated: false,
        };
    }

    const contentType = response.response.headers.get("content-type") ?? "";
    if (isBinaryContentType(contentType)) {
        return {
            url: input.url,
            content: `This address returned ${String(response.raw.byteLength)} bytes of ${contentType}, which is not readable text.`,
            contentType,
            truncated: false,
        };
    }

    const decoded = response.raw.toString("utf8");
    const title = htmlTitle(decoded);
    const content = contentType.includes("text/html")
        ? (await getTurndownService()).turndown(decoded)
        : decoded;
    const limit = input.maxCharacters ?? content.length;
    return {
        url: input.url,
        ...(title === undefined ? {} : { title }),
        content: content.slice(0, limit),
        contentType,
        truncated: content.length > limit,
    };
}

const MAX_TITLE_LENGTH = 2_000;

/** The page's own title, which markdown conversion drops along with the rest of the head. */
function htmlTitle(html: string): string | undefined {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
    const title = match?.[1]?.replace(/\s+/gu, " ").trim();
    return title === undefined || title.length === 0 ? undefined : title.slice(0, MAX_TITLE_LENGTH);
}
