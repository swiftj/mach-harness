/**
 * The address of a draft's own design mock, served by the host (GET /api/slices/<SLICE-NNN>/mocks/<sha256>):
 * the same session, Host and origin checks as every route, the bytes checked against the hash.
 * Null for anything that is not a slice ID and a full SHA-256, so nothing else is ever asked for.
 */
export function mockPictureUrl(sliceId: string, sha256: string): string | null {
  if (!/^SLICE-[0-9]{3,}$/.test(sliceId) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return `/api/slices/${sliceId}/mocks/${sha256}`;
}
