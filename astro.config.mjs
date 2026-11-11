import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://maayanbashan.co.il',
  integrations: [
    sitemap({
      // Pages that carry a noindex must not be advertised in the sitemap
      // either: /certificate is a private utility for course graduates, and
      // the member offers are private, reached by a link rather than by search.
      // /body-language-course-call is an ad landing page, reached from ads only.
      filter: (page) => !['/certificate', '/organizations-members', '/coaches', '/body-language-course-call'].some((p) => page.includes(p)),
    }),
  ],
});
