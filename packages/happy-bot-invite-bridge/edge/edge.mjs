// Preview edge: Apple association, invitation landing page, and the guest API.
// Do not log request URLs: invitation tokens travel in the path.
import http from "node:http";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const configSchema = Type.Object({
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    upstreamPort: Type.Integer({ minimum: 1, maximum: 65535 }),
    teamId: Type.String({ pattern: "^[A-Z0-9]{10}$" }),
    appBundleId: Type.String({ pattern: "^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$", maxLength: 255 }),
    clipBundleId: Type.String({ pattern: "^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$", maxLength: 255 }),
    appStoreId: Type.String({ pattern: "^[0-9]{1,20}$" }),
});
const config = {
    port: Number(process.env.EDGE_PORT ?? 8790),
    upstreamPort: Number(process.env.GATEWAY_PORT ?? 8789),
    teamId: process.env.APPLE_TEAM_ID,
    appBundleId: process.env.APP_BUNDLE_ID,
    clipBundleId: process.env.CLIP_BUNDLE_ID,
    appStoreId: process.env.APP_STORE_ID,
};
if (!Value.Check(configSchema, config)) {
    console.error(
        "Set valid Apple team, app, Clip and App Store IDs, and local edge/gateway ports; see README.",
    );
    process.exit(1);
}

const association = JSON.stringify({
    applinks: {
        details: [
            {
                appIDs: [`${config.teamId}.${config.appBundleId}`],
                components: [{ "/": "/bot/invite/*", comment: "Bot invitations" }],
            },
        ],
    },
    appclips: { apps: [`${config.teamId}.${config.clipBundleId}`] },
});
const landing = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="apple-itunes-app" content="app-id=${config.appStoreId}, app-clip-bundle-id=${config.clipBundleId}, app-clip-display=card">
<title>Happy invitation</title>
<style>body{font:17px -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#111}h1{font-size:1.6rem}p{color:#555;line-height:1.45}</style>
</head><body><h1>You're invited to chat on Happy</h1>
<p>Open this link on an iPhone with the Happy Preview app installed.</p>
</body></html>`;
const securityHeaders = {
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
};

function forward(req, res) {
    const headers = { ...req.headers, host: `127.0.0.1:${config.upstreamPort}` };
    const client = req.headers["cf-connecting-ip"];
    delete headers["x-forwarded-for"];
    if (typeof client === "string" && client.length > 0) headers["x-forwarded-for"] = client;
    const upstream = http.request(
        {
            host: "127.0.0.1",
            port: config.upstreamPort,
            method: req.method,
            path: req.url,
            headers,
        },
        (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
        },
    );
    // A guest dropping a long poll must release the gateway's poll slot at once.
    res.on("close", () => upstream.destroy());
    upstream.on("error", () => {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        res.writeHead(502, { "content-type": "application/json", ...securityHeaders });
        res.end(JSON.stringify({ error: "The chat is temporarily unavailable." }));
    });
    req.pipe(upstream);
}

const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (
        path === "/.well-known/apple-app-site-association" ||
        path === "/apple-app-site-association"
    ) {
        res.writeHead(200, { "content-type": "application/json", ...securityHeaders });
        res.end(association);
        return;
    }
    if (req.method === "GET" && path.startsWith("/bot/invite/")) {
        res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
                "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
            ...securityHeaders,
        });
        res.end(landing);
        return;
    }
    if (
        path === "/v1/bot-invites/redeem" ||
        /^\/v1\/bot-guest\/sessions\/[A-Za-z0-9_-]{43}\/(messages|report|block)$/.test(path)
    ) {
        forward(req, res);
        return;
    }
    res.writeHead(404, { "content-type": "text/plain", ...securityHeaders });
    res.end("Not found");
});

// Long polls wait up to 25s upstream; keep request limits above that.
server.headersTimeout = 40_000;
server.requestTimeout = 60_000;
server.listen(config.port, "127.0.0.1");
