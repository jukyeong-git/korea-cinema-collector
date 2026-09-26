import type { ScheduleTransfer } from './schedule-transfer';
export async function deliverTransfer(payload: ScheduleTransfer, acknowledgedHash: string | undefined,
  invoke: (payload: ScheduleTransfer) => Promise<unknown>, acknowledge: (hash: string) => void, dryRun = false) {
  if (!dryRun && payload.hash === acknowledgedHash) return false;
  const response = await invoke(payload) as { accepted?: boolean; hash?: string; dryRun?: boolean } | null;
  if (!response?.accepted || response.hash !== payload.hash || response.dryRun !== dryRun) throw Error('Receiver did not acknowledge');
  if (!dryRun) acknowledge(payload.hash);
  return true;
}
