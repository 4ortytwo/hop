// Identify only complete tokens matching the encrypted format observed in
// Codex dispatch records. This checks the envelope, never decrypts or verifies
// its contents; ordinary long text and arbitrary base64 remain readable.
export function assignmentReadability(value) {
  if (typeof value !== 'string' || !value.trim()) return 'missing';
  const text = value.trim();
  if (!/^gAAAA[A-Za-z0-9_-]+={0,2}$/.test(text)) return 'readable';
  const token = Buffer.from(text, 'base64url');
  const encoded = token.toString('base64url');
  // Fernet: version (1), timestamp (8), IV (16), ciphertext (16-byte blocks),
  // HMAC (32). Require canonical encoding as Buffer decoding is permissive.
  const opaque = token[0] === 0x80 && token.length >= 73 && (token.length - 57) % 16 === 0
    && (text === encoded || text === encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='));
  return opaque ? 'opaque' : 'readable';
}
