import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const settings = defineCollection({
  loader: glob({ pattern: 'settings.md', base: './src/content/settings' }),
  schema: z.object({
    title: z.string(),
    tagline: z.string(),
    heroImage: z.string(),
    shortBio: z.string(),
    phone: z.string(),
    email: z.string(),
    instagram: z.string().optional(),
    tiktok: z.string().optional(),
    facebook: z.string().optional(),
    youtube: z.string().optional(),
    spotify: z.string().optional(),
    whatsapp: z.string().optional(),
  }),
});

const about = defineCollection({
  loader: glob({ pattern: 'about.md', base: './src/content/about' }),
  schema: z.object({
    title: z.string(),
  }),
});

const organizations = defineCollection({
  loader: glob({ pattern: 'organizations.md', base: './src/content/organizations' }),
  schema: z.object({
    tag: z.string(),
    title: z.string(),
    intro: z.string(),
    benefits: z.array(z.object({ title: z.string(), description: z.string() })),
    // The lecture catalogue. Each entry is rendered as a card and emitted as an
    // offer in the Service structured data, so a lecture added here appears on
    // the page and in the schema without touching the template.
    lectures: z
      .array(
        z.object({
          title: z.string(),
          duration: z.string().optional(),
          summary: z.string(),
          forWhom: z.string().optional(),
          takeaways: z.array(z.string()).default([]),
          // Co-presented lectures name the guest; drives the "בשיתוף" line.
          guest: z.string().optional(),
          featured: z.boolean().default(false),
        })
      )
      .default([]),
    // Numbered "how it works" steps, from first call to the room.
    process: z.array(z.object({ title: z.string(), description: z.string() })).default([]),
    // Photographs from real lectures, shown as a swipeable strip. Alt text is
    // required rather than optional: the strip is the page's only visual proof
    // and it has to describe itself to screen readers and to crawlers.
    photos: z.array(z.object({ src: z.string(), alt: z.string() })).default([]),
    // Rendered on the page and emitted as FAQPage structured data.
    faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
    // Organizations Maayan has actually worked with. Only entries confirmed by
    // email or by a past calendar booking belong here: a quote request is not a
    // client. `logo` is optional, and a name without one renders as a chip, so
    // the strip stays truthful while logo files are collected.
    clients: z.array(z.object({ name: z.string(), logo: z.string().optional() })).default([]),
    // Verbatim quotes. Nothing here may be paraphrased or invented, and an
    // unverified quote stays out of the file rather than going in unattributed.
    testimonials: z
      .array(
        z.object({
          quote: z.string(),
          author: z.string(),
          role: z.string().optional(),
          org: z.string().optional(),
          date: z.string().optional(),
        })
      )
      .default([]),
    closing: z.string(),
  }),
});

const media = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/media' }),
  schema: z.object({
    title: z.string(),
    category: z.enum(['tv', 'podcast', 'article', 'other']),
    // Broadcaster, used to order the TV section by channel.
    outlet: z.enum(['keshet', 'kan', 'i24', 'ynet', 'other']).optional(),
    date: z.coerce.date(),
    url: z.string(),
    image: z.string().optional(),
    description: z.string().optional(),
  }),
});

const courses = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/courses' }),
  schema: z.object({
    title: z.string(),
    format: z.string(),
    contactLink: z.string(),
    image: z.string().optional(),
    featured: z.boolean().default(false),
    // Drives the order on /courses: the soonest upcoming course comes first.
    // `sessions[0]` takes precedence where a course lists its meetings.
    startDate: z.coerce.date().optional(),
    // The cohort's meeting dates. Every date-dependent string on the course
    // pages — cycle label, schedule tickets, schema startDate — is derived from
    // these, so a new cohort only needs its dates changed. See src/lib/cycle.ts.
    sessions: z.array(z.coerce.date()).default([]),
  }),
});

// Long-form SEO/GEO guides. Each one targets a cluster of real search queries
// and carries its own FAQ, which is rendered on the page and emitted as
// FAQPage structured data.
const guides = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/guides' }),
  schema: z.object({
    title: z.string(),
    // Used in listings and breadcrumbs, where the full title is too long.
    shortTitle: z.string(),
    // The <title> tag, when the editorial title would overflow the ~60
    // characters a SERP shows. Falls back to `title`.
    seoTitle: z.string().optional(),
    description: z.string(),
    keywords: z.string(),
    summary: z.string(),
    updated: z.coerce.date(),
    order: z.number().default(99),
    faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
  }),
});

const testimonials = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/testimonials' }),
  schema: z.object({
    author: z.string(),
    quote: z.string(),
    source: z.string().optional(),
  }),
});

const partnerLogos = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/partner_logos' }),
  schema: z.object({
    name: z.string(),
    logo: z.string(),
    // The strip used to run every logo under "כפי שהופיעה ב", which reads as a
    // media appearance and was wrong for the organizations among them. `media`
    // keeps that heading; `client` moves the logo to the organizations strip.
    kind: z.enum(['media', 'client']).default('media'),
    // Set when the artwork is dark and would vanish against the dark strip; it
    // is then recoloured to a white silhouette. Logos that already read light
    // are left alone, because whitening those flattens their interior detail
    // into a solid blob.
    darkArtwork: z.boolean().default(false),
  }),
});

export const collections = {
  settings,
  about,
  organizations,
  media,
  courses,
  guides,
  testimonials,
  partner_logos: partnerLogos,
};
