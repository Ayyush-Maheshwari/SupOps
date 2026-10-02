import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * Fonts for the report: Inter for text, Inter Display for headlines, JetBrains Mono
 * for commands and output (all SIL OFL, vendored under packages/core/assets/fonts).
 * pdfkit subsets what a document actually uses, so embedding them keeps a report in
 * the tens of kilobytes. Helvetica/Courier stay registered for older definitions.
 */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
const f = (name: string) => join(dir, name);

const FONTS = {
  Inter: {
    normal: f('Inter-Regular.ttf'),
    bold: f('Inter-SemiBold.ttf'),
    italics: f('Inter-Italic.ttf'),
    bolditalics: f('Inter-SemiBoldItalic.ttf'),
  },
  Display: {
    normal: f('InterDisplay-SemiBold.ttf'),
    bold: f('InterDisplay-Bold.ttf'),
    italics: f('InterDisplay-SemiBold.ttf'),
    bolditalics: f('InterDisplay-Bold.ttf'),
  },
  Mono: {
    normal: f('JetBrainsMono-Regular.ttf'),
    bold: f('JetBrainsMono-Bold.ttf'),
    italics: f('JetBrainsMono-Regular.ttf'),
    bolditalics: f('JetBrainsMono-Bold.ttf'),
  },
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
  Courier: {
    normal: 'Courier',
    bold: 'Courier-Bold',
    italics: 'Courier-Oblique',
    bolditalics: 'Courier-BoldOblique',
  },
};

const printer = new PdfPrinter(FONTS);

/** Render a document definition to a PDF buffer. */
export function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(definition);
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
