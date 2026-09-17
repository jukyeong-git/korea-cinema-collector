import {
	BatchGetCommand,
	GetCommand,
	PutCommand,
	QueryCommand,
	TransactWriteCommand,
	type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi, afterEach } from "vitest";
import { KnownPks } from "../src/platform/aws/known-pks";
import type { CinemaSession } from "../src/core/types";
import { DynamoDbSessionRepository } from "../src/platform/aws/dynamodb-session-repository";

class MemoryDocumentClient {
	readonly items = new Map<string, Record<string, unknown>>();

	async send(command: unknown): Promise<Record<string, unknown>> {
		if (command instanceof GetCommand) {
			return { Item: this.items.get(String(command.input.Key?.pk)) };
		}

		if (command instanceof BatchGetCommand) {
			const tableName = Object.keys(command.input.RequestItems ?? {})[0];
			const keys = command.input.RequestItems?.[tableName]?.Keys ?? [];
			return {
				Responses: {
					[tableName]: keys
						.map((key) => this.items.get(String(key.pk)))
						.filter(Boolean),
				},
			};
		}

		if (command instanceof PutCommand) {
			const item = command.input.Item as Record<string, unknown>;
			const pk = String(item.pk);
			if (command.input.ConditionExpression && this.items.has(pk)) {
				throw Object.assign(new Error("duplicate"), {
					name: "ConditionalCheckFailedException",
				});
			}
			this.items.set(pk, { ...item });
			return {};
		}

		if (command instanceof QueryCommand) {
			const pending = [...this.items.values()]
				.filter((item) => item.notificationStatus === "pending")
				.sort((left, right) =>
					String(left.notificationSortKey).localeCompare(
						String(right.notificationSortKey),
					),
				);
			const startKey = command.input.ExclusiveStartKey?.pk;
			const startIndex = startKey
				? pending.findIndex((item) => item.pk === startKey) + 1
				: 0;
			const limit = command.input.Limit ?? pending.length;
			const items = pending.slice(startIndex, startIndex + limit);
			const hasMore = startIndex + items.length < pending.length;
			const lastItem = items.at(-1);
			return {
				Items: items,
				LastEvaluatedKey:
					hasMore && lastItem
						? {
								pk: lastItem.pk,
								notificationStatus: lastItem.notificationStatus,
								notificationSortKey: lastItem.notificationSortKey,
							}
						: undefined,
			};
		}

		if (command instanceof TransactWriteCommand) {
			// Validate all transactional puts before applying any mutation.
			for (const operation of command.input.TransactItems ?? []) {
				const put = operation.Put;
				if (!put) continue;
				const old = this.items.get(String(put.Item?.pk));
				if ((put.ConditionExpression === "attribute_not_exists(pk)" && old)
					|| (put.ConditionExpression === "revision = :revision" && old?.revision !== put.ExpressionAttributeValues?.[":revision"])) {
					throw Object.assign(new Error("transaction condition"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
				}
			}
			for (const operation of command.input.TransactItems ?? []) {
				if (operation.Put) {
					const item = operation.Put.Item!;
					this.items.set(String(item.pk), { ...item });
					continue;
				}
				const update = operation.Update;
				const pk = String(update?.Key?.pk);
				const item = this.items.get(pk);
				if (!item || !update) continue;
				if (update.UpdateExpression?.includes("notificationState = :sent")) {
					item.notificationState = "sent";
					item.sentAt = update.ExpressionAttributeValues?.[":now"];
					item.notifiedAt = update.ExpressionAttributeValues?.[":now"];
					delete item.notificationStatus;
					delete item.notificationSortKey;
					delete item.lastError;
				} else {
					item.attempts = Number(item.attempts ?? 0) + 1;
					item.lastError = update.ExpressionAttributeValues?.[":error"];
				}
			}
			return {};
		}

		throw new Error(`Unsupported command: ${String(command)}`);
	}
}

function session(
	performanceId: number,
	title = "오디세이",
): CinemaSession {
	return {
		performanceId: String(performanceId),
		title,
		displayDate: "2026-08-30",
		displayTime: "24:40",
		venue: "CGV 용산아이파크몰 IMAX관",
		formatCode: "IMAX LASER 2D",
		subtitleCode: "자막",
		bookingUrl: "https://cgv.co.kr/cnm/bzplcCgv/0013001",
	};
}

describe("DynamoDbSessionRepository", () => {
	afterEach(() => vi.useRealTimers());

	it("reuses confirmed keys across repositories but rechecks missing and expired keys", async () => {
		vi.useFakeTimers();
		const client = new MemoryDocumentClient();
		const send = vi.spyOn(client, "send");
		const cache = new KnownPks();
		const create = () => new DynamoDbSessionRepository(client as unknown as DynamoDBDocumentClient, "cache-test", { knownPks: cache });
		client.items.set("SESSION#1", { pk: "SESSION#1", performanceId: "1" });
		expect(await create().listKnownPerformanceIds(["1", "2"])).toEqual(new Set(["1"]));
		send.mockClear();
		client.items.set("SESSION#2", { pk: "SESSION#2", performanceId: "2" });
		expect(await create().listKnownPerformanceIds(["1", "2"])).toEqual(new Set(["1", "2"]));
		expect((send.mock.calls[0][0] as BatchGetCommand).input.RequestItems?.["cache-test"].Keys).toEqual([{ pk: "SESSION#2" }]);
		send.mockClear();
		await create().listKnownPerformanceIds(["1", "2"]);
		expect(send).not.toHaveBeenCalled();
		vi.advanceTimersByTime(15 * 60_000);
		await create().listKnownPerformanceIds(["1", "2"]);
		expect(send).toHaveBeenCalledOnce();
	});

	it("caches successful writes without hiding pending notifications or caching failed writes", async () => {
		const client = new MemoryDocumentClient();
		const send = vi.spyOn(client, "send");
		const repository = new DynamoDbSessionRepository(client as unknown as DynamoDBDocumentClient, "write-cache");
		await repository.storeNewSessions([session(1)], "2026-09-09T00:00:00Z", true);
		send.mockClear();
		expect(await repository.listKnownPerformanceIds(["1"])).toEqual(new Set(["1"]));
		expect(send).not.toHaveBeenCalled();
		expect(await repository.listPending()).toHaveLength(1);
		send.mockRejectedValueOnce(new Error("write failed"));
		await expect(repository.storeNewSessions([session(2)], "2026-09-09T00:00:00Z", true)).rejects.toThrow("write failed");
		expect(await repository.listKnownPerformanceIds(["2"])).toEqual(new Set());
	});

	it("stores a baseline and finds known performance IDs", async () => {
		const client = new MemoryDocumentClient();
		const repository = new DynamoDbSessionRepository(
			client as unknown as DynamoDBDocumentClient,
			"cinema-alert",
		);

		expect(await repository.isInitialized()).toBe(false);
		expect(
			await repository.storeNewSessions(
				[session(1)],
				"2026-08-27T00:00:00.000Z",
				false,
			),
		).toBe(1);
		expect(
			await repository.storeNewSessions(
				[session(1)],
				"2026-08-27T00:00:00.000Z",
				false,
			),
		).toBe(0);
		expect(await repository.listKnownPerformanceIds(["1", "2"])).toEqual(
			new Set(["1"]),
		);

		await repository.markInitialized("2026-08-27T00:00:00.000Z");
		expect(await repository.isInitialized()).toBe(true);
	});

	it("keeps failed notifications pending and removes sent ones from the index", async () => {
		const client = new MemoryDocumentClient();
		const repository = new DynamoDbSessionRepository(
			client as unknown as DynamoDBDocumentClient,
			"cinema-alert",
		);
		await repository.storeNewSessions(
			[session(2)],
			"2026-08-27T00:01:00.000Z",
			true,
		);

		expect(await repository.listPending()).toMatchObject([
			{ performanceId: "2", attempts: 0 },
		]);
		await repository.markFailed(["2"], "Telegram unavailable");
		expect(await repository.listPending()).toMatchObject([
			{ performanceId: "2", attempts: 1 },
		]);

		await repository.markSent(["2"], "2026-08-27T00:02:00.000Z");
		expect(await repository.listPending()).toEqual([]);
	});

	it("extends the limit through the final movie group", async () => {
		const client = new MemoryDocumentClient();
		const repository = new DynamoDbSessionRepository(
			client as unknown as DynamoDBDocumentClient,
			"cinema-alert",
		);
		await repository.storeNewSessions(
			[
				session(1, "Alpha"),
				session(2, "Alpha"),
				session(3, "Beta"),
				session(4, "Beta"),
				session(5, "Beta"),
				session(6, "Gamma"),
			],
			"2026-08-27T00:03:00.000Z",
			true,
		);

		const pending = await repository.listPending(4);
		expect(pending.map((item) => item.title)).toEqual([
			"Alpha",
			"Alpha",
			"Beta",
			"Beta",
			"Beta",
		]);
	});
});


describe("preferred-seat transactional outbox", () => {
  const c = { ...session(70), movieNo: "30001323", displayDate: "2026-09-12", seatQuery: { coCd: "A420", siteNo: "0013", scnYmd: "20260912", scnsNo: "018", scnSseq: "4" } };
  it("keeps the silent baseline, atomically creates one event in a race, and retries independently of new-session IDs", async () => {
    const client = new MemoryDocumentClient();
    const repo = new DynamoDbSessionRepository(client as unknown as DynamoDBDocumentClient, "test");
    await repo.storeNewSessions([c], "2026-09-10T00:00:00Z", false);
    expect((await repo.loadSeatContext([c.performanceId])).firstSeen.get(c.performanceId)).toBe("2026-09-10T00:00:00Z");
    await repo.storeSeatObservation(c, { identity: "show", available: [] }, undefined, "2026-09-10T03:00:00Z", []);
    expect(await repo.listPending()).toEqual([]);
    const previous = (await repo.loadSeatContext([c.performanceId])).observations.get(c.performanceId)!;
    const attempts = await Promise.all([1, 2].map(() => repo.storeSeatObservation(c, { identity: "show", available: ["K16"] }, previous, "2026-09-10T03:01:00Z", ["K16"])));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const pending = await repo.listPending(); expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ performanceId: c.performanceId, notificationId: "SEATOPEN#70#2", movieNo: "30001323", releasedSeatLabels: ["K16"] });
    await repo.markFailed([pending[0].notificationId!], "network");
    expect((await repo.listPending())[0].attempts).toBe(1);
    await repo.markSent([pending[0].notificationId!], "now");
    expect(await repo.listPending()).toEqual([]);
    expect(client.items.get("SESSION#70")?.firstSeenAt).toBe("2026-09-10T00:00:00Z");
    expect(client.items.get("SEATSTATE#70")?.available).toEqual(["K16"]);
  });
  it("does not swallow service failures or advance state without the event", async () => {
    const client = new MemoryDocumentClient();
    const repo = new DynamoDbSessionRepository(client as unknown as DynamoDBDocumentClient, "test");
    const send = vi.spyOn(client, "send").mockRejectedValueOnce(Object.assign(Error("throttled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ThrottlingError" }] }));
    await expect(repo.storeSeatObservation(c, { identity: "show", available: ["K16"] }, undefined, "now", ["K16"])).rejects.toThrow("throttled");
    expect(client.items.size).toBe(0); send.mockRestore();
  });
  it("ignores a stale GSI event after successful delivery, and fails incomplete context reads", async () => {
    const client = new MemoryDocumentClient();
    const repo = new DynamoDbSessionRepository(client as unknown as DynamoDBDocumentClient, "test");
    await repo.storeNewSessions([c], "now", true);
    const stale = { ...client.items.get("SESSION#70")! };
    await repo.markSent(["70"], "later");
    const original = client.send.bind(client);
    vi.spyOn(client, "send").mockImplementation(async cmd => cmd instanceof QueryCommand ? { Items: [stale] } : original(cmd));
    expect(await repo.listPending()).toEqual([]);
    vi.restoreAllMocks();
    vi.spyOn(client, "send").mockResolvedValue({ UnprocessedKeys: { test: { Keys: [{ pk: "SESSION#70" }] } } });
    await expect(repo.loadSeatContext(["70"])).rejects.toThrow("incomplete");
  });
});
it("publishes a complete candidate snapshot and skips missing or stale snapshots", async () => {
  const client = new MemoryDocumentClient();
  const repo = new DynamoDbSessionRepository(client as unknown as DynamoDBDocumentClient, "test");
  const stamp = "2026-09-10T04:00:00Z", now = Date.parse(stamp);
  expect(await repo.readSeatCandidates(now)).toBeUndefined();
  await repo.publishSeatCandidates([], stamp);
  expect(await repo.readSeatCandidates(now + 60000)).toEqual([]);
  expect(await repo.readSeatCandidates(now + 180001)).toBeUndefined();
  client.items.set("STATE#sync_lease", { pk: "STATE#sync_lease", expiresAt: now + 1800000 });
  expect(await repo.legacyCooldownActive(now)).toBe(true);
  expect(await repo.legacyCooldownActive(now + 1800001)).toBe(false);
});
