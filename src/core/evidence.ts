/**
 * Content identity for retained findings. Deterministic, local, and computed from the bytes
 * FilePass actually keeps. Uses the platform digest that both the browser and Node provide,
 * so it adds no dependency. When no digest is available the caller gets undefined, and
 * verification treats a kept finding without evidence as unaccounted for.
 */
export async function contentDigest(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  try {
    const copy = new Uint8Array(bytes);   // a detached view would fail here
    const digest = await subtle.digest('SHA-256', copy);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}
