import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import clerk from '@clerk/astro';

// Webflow Cloud sets `base` and `build.assetsPrefix` from the environment's mount path
// (/app on the Probe site) at build time — don't set them here.
// The build for Nassau's own Cloudflare account (PROBE_TARGET=cloudflare) keeps the same /app path.
const own = process.env.PROBE_TARGET === 'cloudflare';
export default defineConfig({
  ...(own ? { base: '/app' } : {}),
  output: 'server',
  devToolbar: { enabled: false },
  // Astro's built-in check would also reject the cross-site tracker beacons (text/plain POSTs),
  // so same-origin enforcement for app forms lives in src/middleware.ts instead.
  security: { checkOrigin: false },
  adapter: cloudflare({ imageService: 'passthrough' }), // no Images binding needed
  integrations: [clerk()],
});
