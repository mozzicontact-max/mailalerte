import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeRss, parseRss } from '../src/rss.js';

test('lit les éléments, les entités et le CDATA', () => {
  const xml = `<rss version="2.0"><channel>
    <item><title>Cours &amp; TD &#233;t&#xE9;</title><description><![CDATA[Maths -> Forums -> <b>Annonces</b>]]></description>
      <author>"Prof (via Moodle Artois)" &lt;ne-pas-repondre@moodle.example.org&gt;</author><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>Deux</title><description/><author>a@example.org</author></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    title: 'Cours & TD été',
    excerpt: 'Maths -> Forums -> <b>Annonces</b>',
    author: '"Prof (via Moodle Artois)" <ne-pas-repondre@moodle.example.org>',
    pubDate: 'Mon, 05 Oct 2026 10:00:00 GMT',
  });
  assert.equal(items[1].excerpt, '');
  assert.equal(items[1].pubDate, '');
});

test('flux vide : zéro élément, mais reconnu comme RSS', () => {
  const xml = '<rss version="2.0"><channel><title>x</title></channel></rss>';
  assert.equal(looksLikeRss(xml), true);
  assert.deepEqual(parseRss(xml), []);
});

test('une page HTML n’est pas un flux RSS', () => {
  assert.equal(looksLikeRss('<!doctype html><html><body>Connexion</body></html>'), false);
});
