# Probe on Nassau's Cloudflare account

`setup.mjs` makes sure an EU-locked database (`probe-eu`), an EU-locked file store (`probe-files-eu`)
and a session store exist, and writes the `wrangler.jsonc` used for the build and deploy.
`.github/workflows/cloudflare.yml` runs it, builds Probe at the `/app` path and deploys the worker `probe-app`.

The deploy runs on every change to main, or by hand from the Actions tab.
The live app on Webflow Cloud is separate and is not changed by it.

Secrets and variables of the worker itself (Clerk, Stripe, Resend, owner emails) are set in the
Cloudflare dashboard and survive deploys.

## Moving the data

Set the secret `PROBE_MIGRATE_KEY` (24 characters or more, the same value) on both deployments.
Then sign in on the new deployment as the service owner and open `/app/admin/migrate`.
The copy can be repeated; nothing is deleted on either side. Remove the secret from both when the move is finished.

## Switching over

The public address stays `probe.nassau.se/app`. The Webflow Cloud deployment hands every request on to this one
(`src/lib/relay.ts`); only the data export stays there so the copy can be repeated.

1. Set the secret `PROBE_RELAY_KEY` (24 characters or more, the same value) on both deployments.
2. On Webflow Cloud set `PROBE_RELAY` to `try`. Only browsers with the cookie `probe-relay=1` are handed on.
3. When that looks right: add the Stripe and Resend secrets to this worker, set `PROBE_RELAY` to `on`,
   and run the copy at `/app/admin/migrate` once more for what arrived in between.
4. Remove `PROBE_MIGRATE_KEY` from both sides. To go back, remove `PROBE_RELAY`.
