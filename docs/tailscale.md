# Private Tailscale hosting

Keep Next.js bound to `127.0.0.1`. Use **Tailscale Serve**, which proxies a local service privately to your Tailnet. This app does not support public Funnel access. See the [official Serve guide](https://tailscale.com/docs/features/tailscale-serve).

1. Install and sign in to Tailscale on the server and your accessing devices using its normal login. Keep the host awake while workers run. Review Tailnet access grants so only your intended devices/users can reach the host's HTTPS port.
2. Determine your host's private HTTPS `device.tailnet.ts.net` address with the Tailscale CLI. Enable HTTPS certificates through Tailscale's own setup if needed. Configure the **exact** origin and allowed Tailscale login(s) privately in `.env.local`:

   ```dotenv
   CROUTER_ORIGIN=http://127.0.0.1:3000
   CROUTER_TAILSCALE_ORIGIN=https://device.tailnet.ts.net
   CROUTER_TAILSCALE_USERS=your-tailnet-login
   ```

   These are placeholders. Never commit your actual Tailnet name or login identifiers. The allowlist accepts comma-separated login names. Keep it to the owner for this single-user workspace; every allowed identity can access every registered project and start workers.

3. Build and start the local production server:

   ```sh
   npm run build
   npm start
   ```

4. Start a private Serve proxy in your terminal:

   ```sh
   tailscale serve --bg http://127.0.0.1:3000
   tailscale serve status
   ```

   Open the resulting HTTPS URL from a signed-in, allowlisted Tailnet device. Verify that it is labeled **Available within your tailnet**. Never run `tailscale funnel` for this app. Serve is a proxy, not a supervisor: keep `npm start` alive with your preferred OS service manager.

When Tailnet mode is enabled, **every API request** requires an allowlisted `Tailscale-User-Login` header inserted by Serve. Tailscale removes spoofed incoming identity headers. The app also validates the exact HTTPS Origin for mutations, the custom same-origin request header, and the proxy Host. Missing identities, shared users outside the allowlist, tagged devices without user identity, and Funnel requests are rejected. A direct localhost browser won't get project API access in this mode; use the private HTTPS URL. Do not put Next on a LAN/Tailnet listening address, because a direct caller could forge proxy identity headers.

The UI and browser application files contain no credentials, but all API data and actions belong to the single host user's workspace. This is private ingress access control, not multi-tenant authorization. Protect the server, its local OS account, and backups. Remove Tailnet configuration to return to strict loopback mode.

To stop this Serve proxy, use the Tailscale CLI's documented configuration controls, inspecting `tailscale serve status` first. Do not reset unrelated Serve applications on the same host. No Tailnet login, access grant, Serve mapping, certificate, or Funnel setting is changed automatically by installing crouter.
