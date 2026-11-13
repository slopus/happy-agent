# Secret requests

Lets an agent ask the person for a credential without ever seeing it.

```ts
new SecretRequestsModule(artifacts, secrets);
```

`request_secret` publishes a `gen_ui` artifact: a card with the agent's explanation, the variables
it needs, and a button whose `secret` action prefills the secret form (`docs/genui/SPEC.md`,
"Secret actions"). It returns at once; the agent does not wait for the person.

The person's client saves the form through
`POST /v0/artifacts/:artifactId/versions/:number/actions`, which the API module hands to
`saveSecretAction`. That method reads the action from the version's stored render document, never
from the request, and in one transaction:

1. creates the secret, or updates the one the form showed when `ifMatch` still matches;
2. attaches it to the agent the version's `createdBy` names;
3. steers that agent one system message, with the save's ID as its message ID, naming the secret,
   its variables, and any variable it asked for that the secret lacks;
4. records the save, so a retry with the same ID answers the first save.

Values go straight to the secrets module. The save table, the message, and every result hold names
only.
