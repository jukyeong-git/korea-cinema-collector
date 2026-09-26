import { it, expect, vi } from 'vitest';
import { deliverTransfer } from '../src/core/transfer-delivery';
import type { ScheduleTransfer } from '../src/core/schedule-transfer';
it('does not acknowledge failed deliveries and does not invoke for an acknowledged hash', async () => {
  const payload = {hash:'a'} as ScheduleTransfer;
  const invoke = vi.fn(), ack=vi.fn();
  expect(await deliverTransfer(payload,'a',invoke,ack)).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockRejectedValueOnce(Error('failure'));
  await expect(deliverTransfer(payload,undefined,invoke,ack)).rejects.toThrow();
  expect(ack).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce({accepted:true,hash:'wrong',dryRun:false});
  await expect(deliverTransfer(payload,undefined,invoke,ack)).rejects.toThrow();
  invoke.mockResolvedValueOnce({accepted:true,hash:'a',dryRun:false});
  expect(await deliverTransfer(payload,undefined,invoke,ack)).toBe(true);
  expect(ack).toHaveBeenCalledWith('a');
});
