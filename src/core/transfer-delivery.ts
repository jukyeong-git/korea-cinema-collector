export async function deliverTransfer<T extends {hash: string}>(payload: T, acknowledgedHash: string | undefined,
  invoke: (payload: T) => Promise<unknown>, acknowledge: (hash: string) => void, dryRun = false, validation: 'strict' | 'accepted' = 'strict') {
  if (!dryRun && payload.hash === acknowledgedHash) return false;
  const response = await invoke(payload) as { accepted?: boolean; hash?: string; dryRun?: boolean } | null;
  if (response?.accepted !== true || (validation === 'strict' && (response.hash !== payload.hash || response.dryRun !== dryRun))) throw Error('Receiver did not acknowledge');
  if (!dryRun) acknowledge(payload.hash);
  return true;
}
