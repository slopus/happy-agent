import {
    BaseProvider,
    BaseSession,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import { structuredGuardianReviewSchema } from "./structuredGuardianReview.js";

/** Requests a complete decision only in the private reviewer system, on its existing provider. */
export class AutoReviewProvider extends BaseProvider {
    readonly #provider: BaseProvider;

    constructor(provider: BaseProvider) {
        super();
        this.#provider = provider;
    }

    override get name() {
        return this.#provider.name;
    }
    override get inputTypes() {
        return this.#provider.inputTypes;
    }
    override get outputTypes() {
        return this.#provider.outputTypes;
    }

    override async session(id: string, options: SessionOptions): Promise<BaseSession> {
        return new AutoReviewSession(await this.#provider.session(id, options));
    }
}

class AutoReviewSession extends BaseSession {
    readonly #session: BaseSession;

    constructor(session: BaseSession) {
        super(session.id);
        this.#session = session;
    }

    override run(ctx: Context, request: SessionRunRequest): SessionStream {
        return this.#session.run(ctx, {
            ...request,
            structuredOutput: {
                name: "permission_review",
                schema: structuredGuardianReviewSchema,
            },
        });
    }

    override compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        return this.#session.compact(ctx, options);
    }

    override destroy(): void | Promise<void> {
        return this.#session.destroy();
    }
}
