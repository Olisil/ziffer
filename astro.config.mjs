import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import clerk from '@clerk/astro';

// Webflow Cloud sets `base` and `build.assetsPrefix` from the environment's mount path
// (/app on the Ziffer site) at build time — don't set them here.
export default defineConfig({
  output: 'server',
  devToolbar: { enabled: false },
  // Astro's built-in check would also reject the cross-site tracker beacons (text/plain POSTs),
  // so same-origin enforcement for app forms lives in src/middleware.ts instead.
  security: { checkOrigin: false },
  adapter: cloudflare({ imageService: 'passthrough' }), // no Images binding needed
  integrations: [clerk()],
});
