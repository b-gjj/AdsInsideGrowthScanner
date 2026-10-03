import test from 'node:test';
import assert from 'node:assert/strict';
import { homeProductLinks, sitemapProductUrls, productRoot, humanize } from '../src/lib/discover.js';

test('product link extraction normalises variants/params and dedupes', () => {
  const html = '<a href="/products/cedar-granules?variant=1">a</a><a href="https://x.com/products/cedar-granules#r">b</a><a href="/collections/all">c</a><a href="/product/lawn-kit">d</a>';
  assert.deepEqual(homeProductLinks(html, 'https://x.com/'), ['https://x.com/products/cedar-granules', 'https://x.com/product/lawn-kit']);
  assert.equal(productRoot('/collections/a/products/p1/extra', 'https://x.com'), 'https://x.com/products/p1');
  assert.equal(humanize('https://x.com/products/cedar-bug-granules'), 'Cedar Bug Granules');
});
test('sitemap extraction keeps only product URLs', () => {
  const xml = '<urlset><url><loc>https://x.com/products/a</loc></url><url><loc>https://x.com/pages/about</loc></url><url><loc>https://x.com/products/b?x=1</loc></url></urlset>';
  assert.deepEqual(sitemapProductUrls(xml, 'https://x.com'), ['https://x.com/products/a', 'https://x.com/products/b']);
});
