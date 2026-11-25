import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pages = ['public/index.html'];
const MARK = '<div class="mark139" lang="hi" aria-hidden="true"><span>१३९</span></div>';

test('every page has exactly one approved 139 mark', () => {
  for (const p of pages) {
    const s = readFileSync(new URL(p, root), 'utf8');
    assert.equal(s.split('class="mark139"').length - 1, 1, p);
    assert.ok(s.includes(MARK), p);
    assert.ok(s.indexOf(MARK) < s.indexOf('<header'), p);
  }
});

test('139 mark css is the approved text', () => {
  const c = readFileSync(new URL('public/css/app.css', root), 'utf8');
  assert.ok(c.includes('.mark139{position:absolute;top:0;left:0;right:0;margin:0;padding:1px 0 0;text-align:center;line-height:1;pointer-events:none;user-select:none;z-index:2147483647;'));
  assert.ok(c.includes('font-size:6px;font-weight:700;color:#0B2A6B}'));
  assert.ok(c.includes('.mark139 span{display:inline-block;border-bottom:.5px solid #7A1010;padding-bottom:.5px}'));
});
