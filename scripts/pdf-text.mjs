/** Crude PDF text extractor, for verifying rendered reports in development. */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const data = readFileSync(process.argv[2]);
const out = [];

for (const part of data.toString('latin1').split('stream').slice(1)) {
  const body = part.split('endstream')[0].replace(/^\r?\n/, '');
  let inflated;
  try {
    inflated = inflateSync(Buffer.from(body, 'latin1')).toString('latin1');
  } catch {
    continue;
  }
  // pdfkit emits: BT <matrix> Tm /Fn size Tf [<hex> kern <hex>] TJ ET
  for (const m of inflated.matchAll(/\[(.*?)\]\s*TJ/gs)) {
    let piece = '';
    for (const h of m[1].matchAll(/<([0-9A-Fa-f]*)>/g)) {
      piece += Buffer.from(h[1], 'hex').toString('latin1');
    }
    if (piece) out.push(piece);
  }
}
console.log(out.join('').replace(/\s+/g, ' '));
