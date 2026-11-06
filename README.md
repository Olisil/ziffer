# Ziffer app

The signed-in Ziffer app (dashboard, sessions, heatmaps, settings) and the cookieless tracker. Built with Astro on Webflow Cloud and mounted at `/app` on the Ziffer site. Sign-in uses Clerk; data is stored in Webflow Cloud SQLite (D1).

## Environment variables (Webflow Cloud → Environment)
- `PUBLIC_CLERK_PUBLISHABLE_KEY` — `pk_…`
- `CLERK_SECRET_KEY` — `sk_…` (add it as a secret; never commit it)

## Local development
```
npm install
echo "ZIFFER_DEV_USER=dev_user" > .dev.vars   # skips Clerk locally
npm run db:migrate:local
npm run dev
```

## Install on a site
`<script defer src="https://<ziffer-domain>/app/z.js" data-site="zs_…"></script>`. The site key is under **Settings** for each environment.
