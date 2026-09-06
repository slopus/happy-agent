import type { BotsModule } from "../../sources/bots/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { ProfileModule } from "../../sources/profile/index.js";

/** Profile storage tests do not run bot tools or configure bootstrap values. */
export function testProfileModule(): ProfileModule {
    return new ProfileModule(
        { configuration: { values: { feature: { team: { enabled: false } } } } } as ConfigModule,
        { forAgent: async () => undefined } as unknown as BotsModule,
    );
}
