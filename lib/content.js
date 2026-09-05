export const topics = [
  { name: 'Kubernetes', slug: 'kubernetes', description: 'Deploy, debug, and understand what is happening inside your cluster.' },
  { name: 'Cloud & DevOps', slug: 'cloud-devops', description: 'Practical delivery workflows and thoughtful platform engineering.' },
  { name: 'Terraform', slug: 'terraform', description: 'Infrastructure as code, with fewer surprises.' },
  { name: 'Career & Learning', slug: 'career-learning', description: 'Build skills that last beyond the next certification.' }
];

export function isPublished(data, now = new Date()) {
  return data.draft !== true && (!data.date || new Date(data.date) <= now);
}

export function plainText(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function readingTime(value = '') {
  return Math.max(1, Math.ceil(plainText(value).split(/\s+/).filter(Boolean).length / 220));
}

export function json(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function validatePost(data) {
  for (const field of ['title', 'description', 'category', 'date']) {
    if (!data[field]) throw new Error(`Post is missing ${field}: ${data.page?.inputPath || ''}`);
  }
  if (!topics.some(topic => topic.name === data.category)) throw new Error(`Unknown topic: ${data.category}`);
  if (!Number.isFinite(new Date(data.date).getTime())) throw new Error(`Invalid post date: ${data.date}`);
  if (data.draft !== undefined && typeof data.draft !== 'boolean') throw new Error('draft must be true or false, not a string');
  if (data.updated && (!Number.isFinite(new Date(data.updated).getTime()) || new Date(data.updated) < new Date(data.date))) throw new Error('updated must be a valid date on or after publication');
  if (data.coverImage && (!/^\/assets\/images\/[a-zA-Z0-9/_-]+\.(png|jpg|jpeg|webp|avif)$/i.test(data.coverImage) || !data.coverImageAlt)) {
    throw new Error('Cover images need a local /assets/images/ raster file and descriptive coverImageAlt');
  }
}

export function activeOffers(offers, now = new Date()) {
  const ids = new Set();
  return offers.filter(offer => {
    if (offer.draft !== undefined && typeof offer.draft !== 'boolean') throw new Error('Offer draft must be a boolean');
    if (offer.draft === true) return false;
    for (const field of ['id', 'title', 'provider', 'description', 'url', 'offer', 'verifiedAt', 'expiresAt']) {
      if (typeof offer[field] !== 'string' || !offer[field].trim()) throw new Error(`Offer missing ${field}`);
    }
    if (ids.has(offer.id)) throw new Error(`Duplicate offer id: ${offer.id}`);
    ids.add(offer.id);
    const destination = new URL(offer.url);
    if (destination.protocol !== 'https:' || destination.username || destination.password) throw new Error('Offers must link to HTTPS provider pages without embedded credentials');
    if (typeof offer.affiliate !== 'boolean' || typeof offer.sponsored !== 'boolean') throw new Error('Offers need explicit affiliate and sponsored disclosure flags');
    const verified = new Date(offer.verifiedAt);
    const expires = new Date(offer.expiresAt);
    if (!Number.isFinite(verified.getTime()) || !Number.isFinite(expires.getTime())) throw new Error('Offer dates must be valid');
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(offer.expiresAt)) throw new Error('Offer expiry needs an explicit time and timezone');
    if (expires <= verified) throw new Error('Offer must expire after verification');
    if (verified > now) throw new Error('Offer verification cannot be in the future');
    return expires > now;
  });
}
