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
