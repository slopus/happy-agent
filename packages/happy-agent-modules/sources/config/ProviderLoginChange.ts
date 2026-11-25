/**
 * What just happened to one account's stored login: a background renewal succeeded (or found the
 * login not yet due), a renewal was refused or failed, or the account was given a new credential.
 * A failure carries only its HTTP status, a vetted OAuth code, and whether only a new sign-in can
 * fix it; never vendor text or credential contents.
 */
export type ProviderLoginChange =
    | { readonly kind: "refreshed" }
    | { readonly kind: "signed_in" }
    | {
          readonly kind: "refresh_failed";
          readonly status: number | null;
          readonly code: string | null;
          readonly permanent: boolean;
      };
