/**
 * Log lines grouped into templates: the variable parts (numbers, IDs, addresses,
 * quoted values, timestamps) replaced by placeholders, so a thousand copies of the
 * same error with different request IDs read as one line with a count.
 */
export function logTemplate(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/"[^"]{0,200}"/g, '"<str>"')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|b|%)?\b/gi, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function clusterLogLines(lines: string[]): Array<{ template: string; count: number; example: string }> {
  const groups = new Map<string, { template: string; count: number; example: string }>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const t = logTemplate(line);
    const g = groups.get(t);
    if (g) g.count++;
    else groups.set(t, { template: t, count: 1, example: line.slice(0, 300) });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
