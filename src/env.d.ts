/// <reference types="astro/client" />
declare module 'cloudflare:workers' {
  export const env: {
    DB: D1Database;
    SESSION: KVNamespace;
    RECORDINGS: R2Bucket;
    ZIFFER_DEV_USER?: string;
    CLERK_SECRET_KEY?: string;
  };
}
