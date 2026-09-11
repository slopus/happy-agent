import { startHappyAgentDaemon } from "../dist/index.js";

/** Test-owned WorkOS public key; signature and claim verification remain real. */
async function main() {
    const jwks = JSON.parse(process.env.HAPPY_SMOKE_JWKS);
    const jwksUrl = "https://api.workos.com/sso/jwks/client_01KZD3XE9YAFAMT0P8TD4HP73E";
    globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === jwksUrl) return Response.json(jwks);
        throw new Error("The HTTP smoke fixture does not permit external network requests.");
    };
    const daemon = await startHappyAgentDaemon({ happyHome: process.env.HAPPY_HOME_DIR });
    process.on("SIGTERM", () => {
        void daemon.close().then(
            () => process.exit(0),
            () => process.exit(1),
        );
    });
    process.stdout.write(`READY ${daemon.httpUrl}\n`);
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
