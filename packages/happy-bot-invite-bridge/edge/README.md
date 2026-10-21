# Preview invitation edge

`edge.mjs` is the standalone local edge copied from the verified public preview.
Apple IDs and local ports come from environment variables validated with TypeBox.
It serves AASA and the invitation landing page, and forwards only the scoped
guest routes. It logs no request data and releases upstream long polls when
clients disconnect.

```text
Cloudflare tunnel -> edge:8790 -> guest gateway:8789 -> exported bot
                    AASA/page
```

It binds loopback and trusts the tunnel's `CF-Connecting-IP`, replacing any
incoming `X-Forwarded-For`. Deploy only behind that Cloudflare boundary. See the
[package README](../README.md) for exact environment variables and commands.
