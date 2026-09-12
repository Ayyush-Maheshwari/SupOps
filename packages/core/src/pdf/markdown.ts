import type { Content, ContentText } from 'pdfmake/interfaces';

/**
 * A small Markdown renderer targeting pdfmake.
 *
 * Scoped deliberately to what agents actually emit -- headings, emphasis, lists,
 * fenced code, tables, blockquotes -- rather than attempting CommonMark. The
 * alternative was converting the whole document to HTML and driving a headless
 * browser, which means shipping Chromium to render a two-page report.
 *
 * Anything it does not recognise falls through as plain text, so an unusual
 * construct degrades to something readable instead of vanishing.
 */

type Inline = ContentText;

const BOLD = /\*\*([^*]+)\*\*|__([^_]+)__/;
/**
 * Italic spans may contain a nested bold run, so the body allows `**` pairs rather
 * than just non-asterisks. Written non-greedily and guarded by lookarounds so that a
 * plain `**bold**` is never mistaken for an italic containing a stray asterisk.
 */
const ITALIC = /(?<!\*)\*((?:[^*]|\*\*)+?)\*(?!\*)|(?<!_)_((?:[^_]|__)+?)_(?!_)/;
const CODE = /`([^`]+)`/;
const LINK = /\[([^\]]+)\]\(([^)]+)\)/;

/** Split one line into styled runs. */
export function inlineToPdf(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;

  while (rest.length > 0) {
    const candidates = [
      { re: CODE, kind: 'code' as const },
      { re: BOLD, kind: 'bold' as const },
      { re: ITALIC, kind: 'italic' as const },
      { re: LINK, kind: 'link' as const },
    ]
      .map((c) => ({ ...c, m: c.re.exec(rest) }))
      .filter((c): c is typeof c & { m: RegExpExecArray } => c.m !== null)
      .sort((a, b) => a.m.index - b.m.index);

    const first = candidates[0];
    if (!first) {
      out.push({ text: rest });
      break;
    }

    if (first.m.index > 0) out.push({ text: rest.slice(0, first.m.index) });

    const body = first.m[1] ?? first.m[2] ?? '';
    switch (first.kind) {
      case 'code':
        // Code is literal by definition -- nothing inside it is markup.
        out.push({ text: body, font: 'Courier', fontSize: 8.5, color: '#b45309' });
        break;
      case 'bold':
        // Emphasis nests: `**Root (`/dev/root`)**` must still render the path as
        // code rather than printing its backticks. Recurse, then apply the style to
        // each run produced.
        out.push(...inlineToPdf(body).map((run) => ({ ...run, bold: true })));
        break;
      case 'italic':
        out.push(...inlineToPdf(body).map((run) => ({ ...run, italics: true })));
        break;
      case 'link':
        out.push({ text: first.m[1] ?? '', link: first.m[2], color: '#1d4ed8', decoration: 'underline' });
        break;
    }

    rest = rest.slice(first.m.index + first.m[0].length);
  }

  return out.length ? out : [{ text: '' }];
}

const HEADING_SIZE: Record<number, number> = { 1: 14, 2: 12.5, 3: 11, 4: 10.5, 5: 10, 6: 10 };

export function markdownToPdf(markdown: string): Content[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content: Content[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code -- taken verbatim, since its whitespace is the content.
    if (trimmed.startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      content.push({
        text: body.join('\n'),
        font: 'Courier',
        fontSize: 8,
        color: '#1f2937',
        background: '#f3f4f6',
        margin: [0, 2, 0, 6],
        preserveLeadingSpaces: true,
      });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      content.push({
        text: inlineToPdf(heading[2]!),
        fontSize: HEADING_SIZE[level] ?? 10,
        bold: true,
        margin: [0, level <= 2 ? 8 : 6, 0, 3],
      });
      i += 1;
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) {
      content.push({
        canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: '#d1d5db' }],
        margin: [0, 6, 0, 6],
      });
      i += 1;
      continue;
    }

    // Table: a header row followed by a |---|---| separator.
    if (trimmed.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1]?.trim() ?? '')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        const raw = lines[i]!.trim();
        if (!/^\|[\s:|-]+\|$/.test(raw)) rows.push(splitRow(raw));
        i += 1;
      }
      if (rows.length) {
        const columns = Math.max(...rows.map((r) => r.length));
        content.push({
          table: {
            headerRows: 1,
            widths: Array.from({ length: columns }, () => '*'),
            body: rows.map((r, ri) =>
              Array.from({ length: columns }, (_, ci) => ({
                text: inlineToPdf(r[ci] ?? ''),
                bold: ri === 0,
                fontSize: 8.5,
                fillColor: ri === 0 ? '#f3f4f6' : undefined,
                margin: [3, 3, 3, 3] as [number, number, number, number],
              })),
            ),
          },
          layout: 'lightHorizontalLines',
          margin: [0, 3, 0, 8],
        });
      }
      continue;
    }

    if (trimmed.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        body.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i += 1;
      }
      content.push({
        text: inlineToPdf(body.join(' ')),
        italics: true,
        color: '#4b5563',
        margin: [10, 2, 0, 6],
      });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      const items: Content[] = [];
      const isOrdered = !!ordered;
      while (i < lines.length) {
        const t = lines[i]!.trim();
        const m = isOrdered ? /^\d+[.)]\s+(.*)$/.exec(t) : /^[-*+]\s+(.*)$/.exec(t);
        if (!m) {
          // A wrapped continuation line belongs to the previous item.
          if (t && !/^([-*+]|\d+[.)])\s/.test(t) && !t.startsWith('#') && items.length) {
            const prev = items[items.length - 1] as { text: Inline[] };
            prev.text = [...prev.text, { text: ' ' }, ...inlineToPdf(t)];
            i += 1;
            continue;
          }
          break;
        }
        items.push({ text: inlineToPdf(m[1]!) });
        i += 1;
      }
      content.push({
        [isOrdered ? 'ol' : 'ul']: items,
        margin: [0, 2, 0, 6],
        fontSize: 9.5,
      } as unknown as Content);
      continue;
    }

    // Plain paragraph, joined across soft line breaks.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!.trim())) {
      para.push(lines[i]!.trim());
      i += 1;
    }
    if (para.length) {
      content.push({ text: inlineToPdf(para.join(' ')), margin: [0, 0, 0, 6], fontSize: 9.5 });
    } else {
      i += 1;
    }
  }

  return content;
}

const isBlockStart = (t: string): boolean =>
  t.startsWith('#') || t.startsWith('```') || t.startsWith('>') || t.startsWith('|') ||
  /^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t);

function splitRow(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}
