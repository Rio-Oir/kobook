// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHtml } from '../../server/src/lib/parse/html.js';
import { parseMarkdown } from '../../server/src/lib/parse/markdown.js';
import type { ParsedDocument, ParseResult } from '../../shared/contracts/index.js';
const fixture = (name: string) => readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
function usable(result: ParseResult): ParsedDocument {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.document;
}
test('Readability and remark retain short Chinese, headings, lists, code, quotes and duplicate identity', async () => {
  const html = usable(parseHtml(await fixture('article-zh.html')));
  const markdown = usable(parseMarkdown(await fixture('article-zh.md')));
  for (const doc of [html, markdown]) {
    assert.ok(doc.blocks.some(b => b.type === 'paragraph' && b.text === '你好。'));
    assert.ok(doc.blocks.some(b => b.type === 'heading' && b.text === '代码'));
    assert.equal(doc.blocks.filter(b => b.type === 'listItem').length, 4);
    assert.ok(doc.blocks.some(b => b.type === 'code' && b.text === 'const x = 1;\nconsole.log(x);' && b.lang === 'ts'));
    assert.ok(doc.blocks.some(b => b.type === 'quote' && b.text === '引用的一句话。'));
    const duplicate = doc.blocks.filter(b => b.text === '重复段落。');
    assert.equal(duplicate.length, 2);
    assert.equal(duplicate[0]!.hash, duplicate[1]!.hash);
    assert.notEqual(duplicate[0]!.id, duplicate[1]!.id);
    assert.deepEqual(doc.blocks.map(b => b.index), doc.blocks.map((_, i) => i + 1));
  }
  // Readability may remove/renumber a title heading; body facts and order must match.
  // `spans` is part of the comparison on purpose. Both extractors find the same
  // emphasis in this fixture by completely different routes — mdast node types
  // versus DOM tag names, over two different strings assembled from two
  // different traversals — so agreement here is evidence that the shared span
  // algebra works, not a tautology. A projection without it would let the two
  // parse paths describe the same document differently while staying green.
  const body = (doc: ParsedDocument) => doc.blocks.filter(b => b.text !== '短段落与结构测试').map(b => ({ type: b.type, text: b.text, ...(b.type === 'code' ? { lang: b.lang } : {}), ...(b.type === 'listItem' ? { ordered: b.ordered } : {}), spans: b.spans ?? null }));
  assert.deepEqual(body(html), body(markdown));
});

test('inline emphasis is recorded as offsets onto the text, never as markup inside it', async () => {
  // The two halves of the inline feature's central promise:
  //
  //  1. the emphasis is *found* — otherwise the projection above would be
  //     comparing two documents that both have no emphasis and passing for
  //     the wrong reason;
  //  2. the markup does not leak into `text`. `text` is what the client slices
  //     to draw a highlight and what the server checks a stored note's
  //     selection against, so a single `*` left behind would move every offset
  //     after it in the block.
  for (const doc of [usable(parseHtml(await fixture('article-zh.html'))), usable(parseMarkdown(await fixture('article-zh.md')))]) {
    const inline = doc.blocks.find(b => b.text.startsWith('这一段有'));
    assert.ok(inline, 'the inline-emphasis paragraph must survive both extractors');
    assert.equal(inline.text, '这一段有 粗体 与 斜体 与 行内代码 与 删除 与 链接。');
    assert.deepEqual(
      inline.spans?.map(s => ({ ...s, text: inline.text.slice(s.start, s.end) })),
      [
        { start: 5, end: 7, kinds: ['strong'], text: '粗体' },
        { start: 10, end: 12, kinds: ['em'], text: '斜体' },
        { start: 15, end: 19, kinds: ['code'], text: '行内代码' },
        { start: 22, end: 24, kinds: ['del'], text: '删除' },
        { start: 27, end: 29, kinds: ['link'], href: 'https://example.com/', text: '链接' },
      ],
    );

    // Nesting collapses to one span carrying both kinds, in the contract's
    // canonical order — two overlapping spans would give the same picture but
    // would not compare equal between extractors.
    const nested = doc.blocks.find(b => b.text.startsWith('粗斜体'));
    assert.ok(nested);
    assert.deepEqual(nested.spans, [{ start: 0, end: 3, kinds: ['strong', 'em'] }]);

    // A list item's emphasis is inside text the extractor joined itself, which
    // is the case where the inserted separator could silently end up inside
    // the emphasis.
    const item = doc.blocks.find(b => b.type === 'listItem' && b.text.startsWith('第一项'));
    assert.equal(item?.text, '第一项 加粗');
    assert.deepEqual(item?.spans, [{ start: 4, end: 6, kinds: ['strong'] }]);

    for (const block of doc.blocks) {
      assert.ok(!block.text.includes('*'), `${block.text} must not contain a marker`);
      assert.ok(!block.text.includes('~~'), `${block.text} must not contain a marker`);
      assert.ok(!block.text.includes('<'), `${block.text} must not contain markup`);
    }
  }
});

test('Empty inputs and metadata-only fixtures are rejected', async () => {
  for (const result of [parseHtml(''), parseMarkdown(' \n '), parseHtml(await fixture('empty.html')), parseMarkdown(await fixture('frontmatter-only.md'))]) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'EMPTY_CONTENT');
  }
});
