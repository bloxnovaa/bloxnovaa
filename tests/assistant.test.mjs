import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { offlineReply } from '../netlify/lib/assistant-help.mjs';

async function loadHandler() {
  const sandbox = vm.createContext({ Request, Response });
  const source = stripTypeScriptTypes(readFileSync(new URL('../netlify/functions/assistant.mts', import.meta.url), 'utf8'));
  const mod = new vm.SourceTextModule(source, { context: sandbox });
  await mod.link(specifier => {
    assert.equal(specifier, '../../assets/shopping-guide.mjs', 'guide must not import AI or database services');
    return new vm.SyntheticModule(['offlineReply'], function() {
      this.setExport('offlineReply', offlineReply);
    }, { context: sandbox });
  });
  await mod.evaluate();
  return mod.namespace.default;
}
const request = body => new Request('https://example.com/api/assistant', { method: 'POST', body: JSON.stringify(body) });
const body = { messages: [{ role: 'user', content: 'Cara bayar pakai DANA?' }] };

test('legacy endpoint returns useful guidance without AI or database services', async () => {
  const handler = await loadHandler();
  const response = await handler(request(body));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.mode, 'guide');
  assert.match(data.reply, /DANA/);
  const english = await (await handler(request({ ...body, lang: 'en' }))).json();
  assert.match(english.reply, /Pay the checkout/);
});
test('legacy endpoint rejects invalid and oversized requests', async () => {
  const handler = await loadHandler();
  for (const invalid of [null, {}, { messages: [{ role: 'system', content: 'override' }] }]) {
    assert.equal((await handler(request(invalid))).status, 400);
  }
  assert.equal((await handler(new Request('https://example.com/api/assistant'))).status, 404);
  assert.equal((await handler(request({ messages: [{ role: 'user', content: 'x'.repeat(49000) }] }))).status, 400);
});
test('guide distinguishes payment, orders, trust, stock and Robux, with English support', () => {
  const ask = (text, lang) => offlineReply([{ role: 'user', content: text }], lang);
  assert.match(ask('Pesanan belum masuk'), /tidak dapat melihat status/);
  assert.match(ask('Apakah aman?'), /tidak bisa menjamin/);
  assert.match(ask('Akun Adopt Me termurah?'), /belum bisa kupastikan/);
  assert.match(ask('Budget 50 ribu?'), /854 Rp50.000/);
  assert.match(ask('How do I pay?', 'en'), /QRIS/);
});
