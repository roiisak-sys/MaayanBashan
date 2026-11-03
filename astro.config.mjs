import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://maayanbashan.co.il',
  integrations: [
    sitemap({
      // Pages that carry a noindex must not be advertised in the sitemap
      // either: /certificate is a private utility for course graduates, and
      // /organizations-members is a private offer for people who attended a
      // lecture, reached by a link rather than by search.
      filter: (page) => !['/certificate', '/organizations-members'].some((p) => page.includes(p)),
    }),
  ],
});
