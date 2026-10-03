// The Outside-In boundary. Findings text must never assert account-level facts we cannot observe publicly.
export const CAN_ASSESS = [
  'Public ad creative, offers and destinations (Meta Ad Library, Google Ads Transparency)',
  'Landing-page and product-page experience, including a controlled mobile shopping journey up to checkout entry',
  'Search visibility signals that are public (robots, sitemap, canonical, brand SERP when obtainable)',
  'Structured data and technical SEO source signals',
  'Marketing and analytics tags DETECTED on public pages',
  'Public DNS email-authentication records (SPF, DMARC, probed DKIM selectors)',
  'Lab performance and automated accessibility results from a repeatable mobile test',
];
export const CANNOT_ASSESS = [
  'Ad spend or budgets', 'Targeting, audiences or exclusions', 'ROAS, CPA, conversion rate or revenue attribution',
  'Campaign, ad set or account structure', 'Pixel / conversion-tracking accuracy (event correctness, deduplication, server-side/CAPI health)', 'Account-level performance, trends or learning status',
];

// Phrases that would overstep the boundary if stated as a finding. Caveats may mention them to disclaim; findings may not assert them.
const PATTERNS = [
  /\b(ad )?spend(ing)?\b/i, /\broas\b/i, /\bcpa\b/i, /\b(ad|media|marketing|daily|monthly) budgets?\b/i, /\btargeting\b/i, /\baudiences?\b/i, /campaign structure/i,
  /pixel (is|are) (accurate|inaccurate|broken|misfiring|firing)/i, /tracking (is|are) (accurate|broken|misfiring)/i, /\b(fir(e|es|ing)) (correctly|incorrectly|properly|accurately)/i,
  /\bconversion rate\b/i, /account performance/i, /\bis (over|under)spending\b/i,
];
export function boundaryViolations(text) {
  return PATTERNS.filter((re) => re.test(text || '')).map((re) => String(re));
}
