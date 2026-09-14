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
  }),
});

export const collections = {
  settings,
  about,
  organizations,
  media,
  courses,
  testimonials,
  partner_logos: partnerLogos,
};
