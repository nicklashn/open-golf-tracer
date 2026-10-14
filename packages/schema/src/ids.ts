/** Short random ids for document entities (not security-sensitive). */
export function newId(prefix = ''): string {
  const a = new Uint8Array(8);
  globalThis.crypto.getRandomValues(a);
  return (
    prefix +
    Array.from(a, (b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, 12)
  );
}
