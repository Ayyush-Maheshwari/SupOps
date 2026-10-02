/**
 * Work out what a stored credential actually is, and say so clearly when it is
 * malformed.
 *
 * Getting this wrong is silent and confusing: an SSH key whose `-----BEGIN-----`
 * armor was lost on paste looks like a password, gets offered as one, and fails
 * twenty seconds later with "All configured authentication methods failed" -- which
 * points at permissions rather than at the paste that mangled it.
 */
export type SecretKind = 'private_key' | 'password';

export interface SecretDiagnosis {
  kind: SecretKind;
  /** Set when the value is almost certainly a broken key rather than a password. */
  problem: string | null;
}

const ARMOR = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const ARMOR_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
/** The base64 body of an OpenSSH key always starts with this marker. */
const OPENSSH_BODY = /^b3BlbnNzaC1rZXktdjE/;
const PEM_BODY = /^MI[A-Za-z0-9+/]/;

export function diagnoseSecret(raw: string): SecretDiagnosis {
  const value = raw.trim();

  if (ARMOR.test(value)) {
    if (!ARMOR_END.test(value)) {
      return {
        kind: 'private_key',
        problem:
          'This looks like a private key but the closing "-----END ... PRIVATE KEY-----" line is ' +
          'missing. Copy the whole file, including the first and last lines.',
      };
    }
    if (/Proc-Type: 4,ENCRYPTED|DEK-Info|bcrypt/.test(value)) {
      return {
        kind: 'private_key',
        problem:
          'This key is protected by a passphrase, which cannot be supplied unattended. ' +
          'Use a key without a passphrase for automation.',
      };
    }
    return { kind: 'private_key', problem: null };
  }

  // Unarmored key material: multi-line base64 that decodes to something key-shaped.
  const firstLine = value.split('\n')[0]?.trim() ?? '';
  const looksLikeKeyBody =
    value.includes('\n') &&
    (OPENSSH_BODY.test(firstLine) || (PEM_BODY.test(firstLine) && firstLine.length > 40));

  if (looksLikeKeyBody) {
    return {
      kind: 'private_key',
      problem:
        'This looks like the body of a private key with its "-----BEGIN ... PRIVATE KEY-----" and ' +
        '"-----END ... PRIVATE KEY-----" lines missing. Those lines are required. Paste the ' +
        'complete file contents, or use: npm run add-key -- <target-slug> <path-to-key>',
    };
  }

  if (value.includes('\n')) {
    return {
      kind: 'password',
      problem: 'A password should be a single line. This value contains line breaks.',
    };
  }

  return { kind: 'password', problem: null };
}

/** True when ssh2 should be handed this as a private key rather than a password. */
export const isPrivateKey = (secret: string): boolean =>
  diagnoseSecret(secret).kind === 'private_key';
