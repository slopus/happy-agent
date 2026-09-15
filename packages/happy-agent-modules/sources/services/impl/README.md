# Service implementation details

`ServiceAccessTokens` owns bounded, stateless, daemon-lifetime establishment credentials. It performs
signature and TypeBox payload validation before comparing the trusted scope. The owning service
module supplies that scope and performs live admission checks; this helper cannot start or revive
an execution.
