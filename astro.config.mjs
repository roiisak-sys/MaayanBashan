import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://maayanbashan.co.il',
  integrations: [
    sitemap({
      // /certificate is a private utility page for course graduates and is
      // marked noindex — it must not be advertised in the sitemap either.
      filter: (page) => !page.includes('/certificate'),
    }),
  ],
});
