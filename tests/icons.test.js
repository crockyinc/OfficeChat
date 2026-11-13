import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('all inline SVG icon references resolve and controls keep accessible labels', async () => {
  const html = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const symbols = new Set([...html.matchAll(/<symbol id="(icon-[^"]+)"/g)].map(m => m[1]));
  const uses = [...html.matchAll(/<use href="#(icon-[^"]+)"/g)].map(m => m[1]);
  assert.ok(uses.length > 10);
  for (const id of uses) assert.ok(symbols.has(id), `${id} is defined`);
  for (const id of ['attach', 'theme', 'emoji-button', 'menu']) {
    assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*aria-label="[^"]+"`));
  }
  for (const id of ['icon-wifi', 'icon-lock', 'icon-devices', 'icon-attach', 'icon-moon', 'icon-sun']) {
    assert.ok(uses.includes(id), `${id} is used`);
  }
});
