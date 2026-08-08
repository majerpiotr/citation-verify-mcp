// scripts/measure-response-size.mjs
//
// Measures the tool RESPONSE size against the input size, which is what MAX_REPORTED_CITATIONS
// in src/resolver.ts exists to bound. Kept because the constant's value is an empirical choice:
// the round-3 review found a schema-valid 1 MiB input producing a 36.9 MB JSON result in
// milliseconds with ZERO backend calls, so neither MAX_DISTINCT_DOCUMENTS nor the abort checks
// engaged. Anyone changing the cap should re-run this rather than reason about it.
//
// The client here is a FAKE that always answers found - no network, no API key. Run it against
// the built output:
//
//   npm run build && node scripts/measure-response-size.mjs
//
// Expected today: the last column stays flat at roughly 0.75 MB however large the input gets.
// Before the cap it grew with the input, at about 37x.
import { verifyCitations } from "../dist/resolver.js";

const client = {
  async getDocument(n) {
    return { found: true, doc: { name: n, pageCount: 10 } };
  },
  async getNodeIds() {
    return new Set(["0000"]);
  },
};

// Distinct names on purpose: identical citations collapse to one, so a repeated token would
// measure the dedup rather than the response size.
for (const kib of [10, 50, 100, 250, 1024]) {
  const target = kib * 1024;
  const parts = [];
  let i = 0;
  while (parts.join(" ").length < target) {
    parts.push(`d${i}.pdf`);
    i++;
  }
  const text = parts.join(" ").slice(0, target);
  const r = await verifyCitations(text, client);
  const j = JSON.stringify(r);
  console.log(
    `in ${String(kib).padStart(4)} KiB -> total ${String(r.total).padStart(6)}` +
      `  reported ${String(r.details.length).padStart(5)}  truncated ${String(r.truncated).padStart(6)}` +
      `  out ${(j.length / 1024 / 1024).toFixed(2)} MiB  (${(j.length / text.length).toFixed(0)}x)`,
  );
}

// The realistic shape a draft actually has: a few dozen documents cited many times each. It must
// stay far under the cap, so no ordinary call is ever truncated.
const real = Array.from(
  { length: 400 },
  (_, k) => `As shown in d${k % 50}.pdf p.${(k % 9) + 1}, the figure holds.`,
).join(" ");
const rr = await verifyCitations(real, client);
console.log(
  `realistic in ${real.length} chars -> total ${rr.total}, truncated ${rr.truncated}, ` +
    `out ${JSON.stringify(rr).length} bytes`,
);
