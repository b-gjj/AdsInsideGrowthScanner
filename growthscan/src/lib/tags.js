// Public tag detection from rendered DOM + observed network requests. DETECTION ONLY — never "firing correctly".
const SIGS = [
  ['analytics', 'Google Tag Manager', /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,10}/],
  ['analytics', 'Google Analytics 4 / gtag', /googletagmanager\.com\/gtag\/js|google-analytics\.com\/g\/collect|analytics\.google\.com\/g\/collect/],
  ['analytics', 'Universal Analytics (deprecated)', /google-analytics\.com\/(analytics|ga)\.js|UA-\d{4,10}-\d+/],
  ['analytics', 'Microsoft Clarity', /clarity\.ms/], ['analytics', 'Hotjar', /static\.hotjar\.com|hotjar\.io/],
  ['analytics', 'Heap', /heapanalytics\.com/], ['analytics', 'Segment', /cdn\.segment\.(com|io)/], ['analytics', 'Mixpanel', /cdn\.mxpnl\.com|mixpanel\.com\/track/],
  ['attribution', 'Triple Whale', /triplewhale/i], ['attribution', 'Northbeam', /northbeam/i], ['attribution', 'Elevar', /elevar/i], ['attribution', 'Littledata', /littledata/i],
  ['advertising', 'Meta Pixel', /connect\.facebook\.net\/[^"']*\/fbevents\.js|facebook\.com\/tr[/?]/],
  ['advertising', 'Google Ads / DoubleClick', /googleadservices\.com|googleads\.g\.doubleclick\.net|\bAW-\d{6,12}\b/],
  ['advertising', 'TikTok Pixel', /analytics\.tiktok\.com/], ['advertising', 'Pinterest Tag', /ct\.pinterest\.com|s\.pinimg\.com\/ct\/core\.js/],
  ['advertising', 'Snap Pixel', /sc-static\.net\/scevent/], ['advertising', 'Reddit Pixel', /redditstatic\.com\/ads\/pixel/], ['advertising', 'Microsoft Ads (UET)', /bat\.bing\.com/],
  ['email_sms', 'Klaviyo', /klaviyo\.com/], ['email_sms', 'Attentive', /attn\.tv|attentivemobile/], ['email_sms', 'Postscript', /postscript\.io/], ['email_sms', 'Omnisend', /omnisnippet|omnisend/i],
  ['email_sms', 'Mailchimp', /chimpstatic\.com|list-manage\.com/], ['email_sms', 'Yotpo SMS/Email', /swellrewards|yotpo\.com\/.*sms/i],
  ['reviews_ugc', 'Okendo', /okendo\.io/], ['reviews_ugc', 'Yotpo Reviews', /staticw2\.yotpo\.com|cdn-widgetsrepository\.yotpo\.com/], ['reviews_ugc', 'Judge.me', /judge\.me|judgeme/i],
  ['reviews_ugc', 'Stamped', /stamped\.io/], ['reviews_ugc', 'Loox', /loox\.io/], ['reviews_ugc', 'Trustpilot widget', /widget\.trustpilot\.com|tp\.widget\.bootstrap/],
  ['consent', 'Cookiebot', /cookiebot\.com/], ['consent', 'OneTrust', /onetrust\.com|cookielaw\.org/], ['consent', 'Osano', /osano\.com/], ['consent', 'Termly', /termly\.io/], ['consent', 'Iubenda', /iubenda\.com/],
  ['consent', 'Shopify Customer Privacy API', /customerPrivacy|privacy-banner/i],
  ['commerce', 'Shopify', /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/], ['commerce', 'Shop Pay / Shopify Payments', /shop\.app|shopifycs\.com|shop-pay/i],
  ['commerce', 'WooCommerce', /woocommerce|wp-content\/plugins\/woocommerce/i], ['commerce', 'BigCommerce', /bigcommerce\.com|cdn11\.bigcommerce/],
];

export function detectTags({ html = '', requests = [] }) {
  const corpus = html + '\n' + requests.map((r) => r.url).join('\n');
  const found = [];
  for (const [category, name, re] of SIGS) {
    const m = corpus.match(re);
    if (m) {
      const via = [];
      if (requests.some((r) => re.test(r.url))) via.push('network-request');
      if (re.test(html)) via.push('page-source');
      found.push({ category, name, via });
    }
  }
  const ids = {
    ga4: [...new Set((corpus.match(/\bG-[A-Z0-9]{8,12}\b/g) || []))],
    gtm: [...new Set((corpus.match(/\bGTM-[A-Z0-9]{4,10}\b/g) || []))],
    googleAds: [...new Set((corpus.match(/\bAW-\d{6,12}\b/g) || []))],
    metaPixel: [...new Set([...(corpus.matchAll(/fbq\(\s*['"]init['"]\s*,\s*['"]?(\d{8,17})/g))].map((m) => m[1]).concat([...corpus.matchAll(/facebook\.com\/tr[^"'\s]*[?&]id=(\d{8,17})/g)].map((m) => m[1])))],
  };
  return { found, ids };
}
