import { providerSignInComponent } from "@slopus/happy-agent-client";
import type { Context } from "@steve.kite/stdlib";

import type { ChatUiModule } from "../../chatUi/index.js";
import type { ProviderClisModule } from "../ProviderClisModule.js";
import { ProviderCliRequestError, type ProviderCli, type ProviderCliId } from "../ProviderCli.js";

/** Each AI by its provider CLI name, as the sign-in row and onboarding name it. */
const NAMES: Readonly<Record<ProviderCliId, string>> = {
    claude: "Claude Code",
    codex: "Codex",
    grok: "Grok",
    antigravity: "Antigravity",
};

/**
 * Serve `provider_sign_in`: one assistant's install and sign-in, live in the chat. Each action
 * calls this module directly, never its HTTP routes. A connection, now or when a sign-in finishes
 * later in the browser or the person's own terminal, is announced and leaves the conversation a
 * note that wakes its model, unless a listener such as onboarding tells the conversation itself.
 * With `account: "new"`, the widget signs in another account instead, and its note follows that
 * account until it is signed in.
 */
export function contributeSignInComponent(chatUi: ChatUiModule, clis: ProviderClisModule): void {
    /**
     * Conversations whose widget started an install or a sign-in that has not finished, each with
     * the account it adds, or `null` for the assistant's default sign-in.
     */
    const awaiting = new Map<ProviderCliId, Map<string, string | null>>();
    const follow = (id: ProviderCliId, agentId: string, accountId: string | null = null) => {
        const agents = awaiting.get(id) ?? new Map<string, string | null>();
        agents.set(agentId, accountId);
        awaiting.set(id, agents);
    };
    const refused = (error: unknown) => {
        if (!(error instanceof ProviderCliRequestError)) throw error;
        return { status: "rejected" as const, code: error.code, reason: error.message };
    };
    const connected = async (ctx: Context, cli: ProviderCli, agentId: string) => {
        const told = await clis.connected(ctx, cli, agentId);
        return { note: `${NAMES[cli.id]} is connected and signed in.`, wake: !told };
    };

    clis.onUpdated((cli) => {
        const agents = awaiting.get(cli.id);
        if (agents === undefined || agents.size === 0) return;
        const operation = cli.operation;
        const ctx = chatUi.context();
        // An install the widget started goes on to sign in by itself.
        if (
            operation?.kind === "install" &&
            operation.status === "succeeded" &&
            cli.installation.status === "installed" &&
            cli.signIn.status !== "signed_in"
        ) {
            void clis.signIn(ctx, cli.id, undefined).catch((error: unknown) => {
                ctx.log.warn("A widget's sign-in could not start after its install.", {}, error);
            });
            return;
        }
        for (const [agentId, accountId] of agents) {
            if (accountId === null) {
                if (cli.signIn.status !== "signed_in" || operation?.status === "running") continue;
                agents.delete(agentId);
                void connected(ctx, cli, agentId)
                    .then(async ({ note, wake }) => await chatUi.note(ctx, agentId, note, wake))
                    .catch((error: unknown) => {
                        ctx.log.warn("A sign-in note could not be left.", {}, error);
                    });
                continue;
            }
            const account = cli.accounts?.find((candidate) => candidate.id === accountId);
            if (account?.signIn !== "signed_in") continue;
            agents.delete(agentId);
            const note = `Another ${NAMES[cli.id]} account is connected and signed in${account.email === undefined ? "" : ` as ${account.email}`}.`;
            void chatUi.note(ctx, agentId, note, true).catch((error: unknown) => {
                ctx.log.warn("A sign-in note could not be left.", {}, error);
            });
        }
        if (agents.size === 0) awaiting.delete(cli.id);
    });

    chatUi.contribute(providerSignInComponent, {
        prompt: "One AI's install and sign-in, live: it installs the AI's program when it is missing, opens its own sign-in, and takes a sign-in code or a pasted setup token or API key. Show one per AI the person may connect. With `account: \"new\"` it adds another account of a connected Claude Code or Codex instead. A finished sign-in reaches you as a hidden note, in a turn of its own.",
        fallback: (props) =>
            props.account === "new"
                ? `Add another ${NAMES[props.provider]} account in Happy on your computer.`
                : `Sign in to ${NAMES[props.provider]} in Happy on your computer.`,
        actions: {
            install: async (ctx, offer) => {
                try {
                    await clis.install(ctx, offer.props.provider);
                } catch (error: unknown) {
                    return refused(error);
                }
                follow(offer.props.provider, offer.agentId);
                return { status: "accepted" };
            },
            sign_in: async (ctx, offer) => {
                if (offer.props.account === "new") {
                    let accountId: string | undefined;
                    try {
                        ({ accountId } = await clis.addAccount(
                            ctx,
                            offer.props.provider,
                            undefined,
                        ));
                    } catch (error: unknown) {
                        return refused(error);
                    }
                    if (accountId !== undefined) {
                        follow(offer.props.provider, offer.agentId, accountId);
                    }
                    return {
                        status: "accepted",
                        result: accountId === undefined ? {} : { accountId },
                    };
                }
                const cli = await clis.get(ctx, offer.props.provider);
                // Signed in already: it connects as it is.
                if (cli.signIn.status === "signed_in") {
                    return {
                        status: "accepted",
                        ...(await connected(ctx, cli, offer.agentId)),
                        result: {},
                    };
                }
                try {
                    await clis.signIn(ctx, offer.props.provider, undefined);
                } catch (error: unknown) {
                    return refused(error);
                }
                follow(offer.props.provider, offer.agentId);
                return { status: "accepted", result: {} };
            },
            submit_code: async (ctx, offer, { code }) => {
                try {
                    await clis.submitCode(ctx, offer.props.provider, code);
                } catch (error: unknown) {
                    return refused(error);
                }
                return { status: "accepted" };
            },
            submit_token: async (ctx, offer, { token }) => {
                const saved = await clis.saveToken(ctx, offer.props.provider, token);
                if (!saved.saved) {
                    return { status: "rejected", code: saved.code, reason: saved.reason };
                }
                const name = NAMES[offer.props.provider];
                if (saved.restartRequired) {
                    return {
                        status: "accepted",
                        note: `${name}'s token is saved. Happy uses it after it restarts.`,
                    };
                }
                const cli = await clis.get(ctx, offer.props.provider);
                return { status: "accepted", ...(await connected(ctx, cli, offer.agentId)) };
            },
            cancel: async (ctx, offer) => {
                await clis.cancel(ctx, offer.props.provider);
                awaiting.get(offer.props.provider)?.delete(offer.agentId);
                return { status: "accepted" };
            },
        },
    });
}
