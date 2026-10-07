/**
 * Every claim in an incident report should point at evidence. The model cites the
 * evidence pack as [E1], [E2]...; this checks those references against what was
 * actually gathered, so a citation to evidence that does not exist is flagged
 * instead of lending a guess the look of a finding.
 */
export function checkCitations(text: string, known: Iterable<string>): { cited: string[]; unknown: string[] } {
  const have = new Set(known);
  const cited = [...new Set([...text.matchAll(/\[(E\d{1,3})\]/g)].map((m) => m[1]!))];
  return { cited, unknown: cited.filter((c) => !have.has(c)) };
}

/**
 * The report's verdict, from its "Root cause" and "Confidence" lines. Tolerates the
 * usual Markdown decoration (bold, a heading, a list bullet).
 */
export type IncidentAction = 'act_now' | 'can_wait' | 'none';

/** "act now" / "can wait" / "none needed", however the model decorated it. */
export function parseAction(text: string): IncidentAction | null {
  const m = text.replace(/\*\*|__/g, '').match(/^[#>\-*\s]*action\s*[:\-–]\s*(.+)$/im);
  const v = m?.[1]?.toLowerCase() ?? '';
  if (/act now|urgent|immediate/.test(v)) return 'act_now';
  if (/can wait|soon|schedule|later/.test(v)) return 'can_wait';
  if (/none|no action|not needed|nothing/.test(v)) return 'none';
  return null;
}

export function parseVerdict(text: string): { rootCause: string | null; confidence: 'high' | 'medium' | 'low' | 'inconclusive' | null } {
  const plain = text.replace(/\*\*|__/g, '');
  const rc = plain.match(/^[#>\-*\s]*root cause\s*[:\-–]\s*(.+)$/im) ?? plain.match(/^#+\s*root cause\s*\n+\s*(.+)$/im);
  const conf = plain.match(/confidence\s*[:\-–]?\s*\(?\s*(high|medium|low|inconclusive)\b/i);
  const rootCause = rc?.[1]?.trim().replace(/\s*\(?confidence[^)]*\)?\s*$/i, '').slice(0, 500) || null;
  let confidence = (conf?.[1]?.toLowerCase() ?? null) as 'high' | 'medium' | 'low' | 'inconclusive' | null;
  if (!confidence && rootCause && /^inconclusive\b/i.test(rootCause)) confidence = 'inconclusive';
  return { rootCause, confidence };
}
