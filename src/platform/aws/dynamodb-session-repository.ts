import {
	BatchGetCommand,
  UpdateCommand,
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KnownPks, knownSessionPks } from "./known-pks";
import { SEAT_POLICY, type SeatObservation, type SeatMonitorRepository } from "../../core/seat-monitor";
import type { SeatCandidate, SeatSnapshot } from "../../core/types";
import { comparePendingNotifications } from "../../core/order";
import type { SessionRepository } from "../../core/session-repository";
import type {
	CinemaSession,
	PendingNotification,
} from "../../core/types";

const BASELINE_KEY = "STATE#baseline_initialized";
const PENDING_STATUS = "pending";
const DEFAULT_PENDING_INDEX = "pending-index";
const DEFAULT_PENDING_LIMIT = 500;
const GROUP_BOUNDARY_PAGE_SIZE = 100;

interface DynamoDbSessionRepositoryOptions {
	pendingIndexName?: string;
	knownPks?: KnownPks;
}

interface SessionItem extends PendingNotification {
	pk: string;
	entityType: "SESSION";
	firstSeenAt: string;
	notificationState?: "pending" | "sent";
	notificationStatus?: "pending";
	notificationSortKey?: string;
	attempts: number;
	lastError?: string;
	sentAt?: string;
	notifiedAt?: string;
}

function sessionKey(performanceId: string): string {
	return `SESSION#${performanceId}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		result.push(items.slice(index, index + size));
	}
	return result;
}

function pendingSortKey(session: CinemaSession): string {
	return [
		session.title,
		session.displayDate,
		session.venue,
		session.displayTime,
		String(session.performanceId),
	].join("#");
}

function isConditionalCheckFailure(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "ConditionalCheckFailedException"
	);
}

function toPendingNotification(item: SessionItem): PendingNotification {
	return {
		performanceId: item.performanceId,
		title: item.title,
    ...(item.movieNo ? { movieNo: item.movieNo } : {}),
		displayDate: item.displayDate,
		displayTime: item.displayTime,
		venue: item.venue,
		formatCode: item.formatCode,
		subtitleCode: item.subtitleCode ?? null,
		bookingUrl: item.bookingUrl,
		attempts: item.attempts ?? 0,
    ...(item.notificationId ? { notificationId: item.notificationId } : {}),
    ...(item.releasedSeatLabels ? { releasedSeatLabels: item.releasedSeatLabels } : {}),
	};
}

function isSameNotificationGroup(
	item: SessionItem,
	boundary: SessionItem,
): boolean {
	return item.title === boundary.title;
}

export class DynamoDbSessionRepository implements SessionRepository, SeatMonitorRepository {
	private readonly pendingIndexName: string;
	private readonly knownPks: KnownPks;
  private readonly writtenPendingPks = new Set<string>();

	constructor(
		private readonly client: DynamoDBDocumentClient,
		private readonly tableName: string,
		options: DynamoDbSessionRepositoryOptions = {},
	) {
		this.pendingIndexName =
			options.pendingIndexName ?? DEFAULT_PENDING_INDEX;
		this.knownPks = options.knownPks ?? new KnownPks();
	}

	async isInitialized(): Promise<boolean> {
		const result = await this.client.send(
			new GetCommand({
				TableName: this.tableName,
				Key: { pk: BASELINE_KEY },
				ConsistentRead: true,
			}),
		);
		return result.Item?.value === true;
	}

	async listKnownPerformanceIds(
		performanceIds: readonly string[],
	): Promise<Set<string>> {
		const known = new Set<string>();
		const uniqueIds = [...new Set(performanceIds)].filter((id) => {
			if (!this.knownPks.has(this.tableName, sessionKey(id))) return true;
			known.add(id);
			return false;
		});

		for (const batch of chunks(uniqueIds, 100)) {
			let keys: Record<string, string | number>[] = batch.map((performanceId) => ({
				pk: sessionKey(performanceId),
			}));

			for (let attempt = 0; keys.length > 0 && attempt < 5; attempt += 1) {
				const result = await this.client.send(
					new BatchGetCommand({
						RequestItems: {
							[this.tableName]: {
								Keys: keys,
								ProjectionExpression: "pk, performanceId",
								ConsistentRead: true,
							},
						},
					}),
				);

				for (const item of result.Responses?.[this.tableName] ?? []) {
					if (typeof item.performanceId === "string") {
						known.add(item.performanceId);
						this.knownPks.add(this.tableName, sessionKey(item.performanceId));
					}
				}
				keys = result.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
			}

			if (keys.length > 0) {
				throw new Error(
					`DynamoDB left ${keys.length} session keys unprocessed after retries.`,
				);
			}
		}

		return known;
	}

	async storeNewSessions(
		sessions: CinemaSession[],
		now: string,
		createNotifications: boolean,
	): Promise<number> {
		let stored = 0;

		for (const batch of chunks(sessions, 10)) {
			const results = await Promise.all(
				batch.map(async (session) => {
					const notification = createNotifications
						? {
								notificationState: PENDING_STATUS,
								notificationStatus: PENDING_STATUS,
								notificationSortKey: pendingSortKey(session),
								attempts: 0,
							}
						: {};

					try {
						await this.client.send(
							new PutCommand({
								TableName: this.tableName,
								Item: {
									pk: sessionKey(session.performanceId),
									entityType: "SESSION",
									...session,
									firstSeenAt: now,
									...notification,
								},
								ConditionExpression: "attribute_not_exists(pk)",
							}),
						);
						this.knownPks.add(this.tableName, sessionKey(session.performanceId));
            if (createNotifications) this.writtenPendingPks.add(sessionKey(session.performanceId));
						return 1;
					} catch (error) {
						if (isConditionalCheckFailure(error)) return 0;
						throw error;
					}
				}),
			);
			stored += results.reduce<number>((total, count) => total + count, 0);
		}

		return stored;
	}

  async publishSeatCandidates(candidates: SeatCandidate[], observedAt: string) {
    const item = { pk: "STATE#seat_candidates", candidates, observedAt };
    if (Buffer.byteLength(JSON.stringify(item)) > 350_000) throw Error("Seat candidate snapshot exceeds safe DynamoDB item size");
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async readSeatCandidates(now = Date.now()): Promise<SeatCandidate[] | undefined> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName,
      Key: { pk: "STATE#seat_candidates" }, ConsistentRead: true }));
    if (!Item) return undefined;
    const age = now - Date.parse(Item.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 180_000) return undefined;
    if (!Array.isArray(Item.candidates)) throw Error("Malformed stored seat candidates");
    return Item.candidates as SeatCandidate[];
  }

  async legacyCooldownActive(now = Date.now(), leaseKey = "STATE#sync_lease") {
    // Do not erase a pre-split CGV Retry-After cooldown by changing lease keys.
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName,
      Key: { pk: leaseKey }, ConsistentRead: true }));
    return Number(Item?.expiresAt ?? 0) > now;
  }

  private async readItems(pks: string[]): Promise<Map<string, Record<string, unknown>>> {
    const items = new Map<string, Record<string, unknown>>();
    for (const batch of chunks([...new Set(pks)], 100)) {
      let keys: Record<string, unknown>[] = batch.map(pk => ({ pk }));
      for (let attempt = 0; keys.length && attempt < 5; attempt++) {
        const result = await this.client.send(new BatchGetCommand({ RequestItems: {
          [this.tableName]: { Keys: keys, ConsistentRead: true },
        } }));
        for (const item of result.Responses?.[this.tableName] ?? []) items.set(String(item.pk), item);
        keys = result.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
        if (keys.length) await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
      }
      if (keys.length) throw Error("DynamoDB seat/context read incomplete");
    }
    return items;
  }

  async loadSeatContext(ids: string[]) {
    const firstSeen = new Map<string, string>(), observations = new Map<string, SeatObservation>();
    // No positive-PK cache here: firstSeen metadata and mutable snapshots are
    // authoritative table state and must survive cold starts and racing calls.
    const items = await this.readItems(ids.flatMap(id => [sessionKey(id), `SEATSTATE#${id}`]));
    for (const id of ids) {
      const first = items.get(sessionKey(id))?.firstSeenAt;
      if (typeof first === "string") firstSeen.set(id, first);
      const state = items.get(`SEATSTATE#${id}`);
      if (state) {
        if (!Number.isSafeInteger(state.revision) || !Array.isArray(state.available) || state.available.some(x => typeof x !== "string")
          || typeof state.identity !== "string" || typeof state.policy !== "string" || typeof state.observedAt !== "string") throw Error("Malformed stored seat snapshot");
        observations.set(id, state as unknown as SeatObservation);
      }
    }
    return { firstSeen, observations };
  }

  async storeSeatObservation(candidate: SeatCandidate, snapshot: SeatSnapshot, previous: SeatObservation | undefined, now: string, released: string[]): Promise<boolean> {
    const revision = (previous?.revision ?? 0) + 1;
    const notificationId = `SEATOPEN#${candidate.performanceId}#${revision}`;
    const expiresAt = Math.floor(Date.parse(`${candidate.displayDate}T00:00:00+09:00`) / 1000) + 7 * 86400;
    const operations: NonNullable<TransactWriteCommandInput["TransactItems"]> = [{ Put: {
      TableName: this.tableName,
      Item: { pk: `SEATSTATE#${candidate.performanceId}`, entityType: "SEAT_STATE", ...snapshot, revision, policy: SEAT_POLICY, observedAt: now, ttl: expiresAt },
      ConditionExpression: previous ? "revision = :revision" : "attribute_not_exists(pk)",
      ...(previous ? { ExpressionAttributeValues: { ":revision": previous.revision } } : {}),
    } }];
    if (released.length) operations.push({ Put: {
      TableName: this.tableName,
      Item: { ...candidate, pk: sessionKey(notificationId), entityType: "SEAT_EVENT", notificationId,
        releasedSeatLabels: released, firstSeenAt: now, notificationState: "pending", notificationStatus: PENDING_STATUS,
        notificationSortKey: pendingSortKey(candidate) + "#" + notificationId, attempts: 0, ttl: expiresAt },
      ConditionExpression: "attribute_not_exists(pk)",
    } });
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: operations }));
      if (released.length) this.writtenPendingPks.add(sessionKey(notificationId));
      return true;
    } catch (error) {
      // Only an OCC conflict is safe to skip; throttling/service failures must
      // propagate instead of being misreported as another writer's success.
      if (error && typeof error === "object" && "name" in error && error.name === "TransactionCanceledException"
        && "CancellationReasons" in error && Array.isArray(error.CancellationReasons)
        && error.CancellationReasons.some(r => r.Code === "ConditionalCheckFailed")
        && error.CancellationReasons.every(r => !r.Code || ["None", "ConditionalCheckFailed"].includes(r.Code))) return false;
      throw error;
    }
  }

	async markInitialized(now: string): Promise<void> {
		await this.client.send(
			new PutCommand({
				TableName: this.tableName,
				Item: {
					pk: BASELINE_KEY,
					entityType: "STATE",
					value: true,
					updatedAt: now,
				},
			}),
		);
	}

	async listPending(limit = DEFAULT_PENDING_LIMIT): Promise<PendingNotification[]> {
		if (limit < 1) return [];

		const items: SessionItem[] = [];
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const result = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					IndexName: this.pendingIndexName,
					KeyConditionExpression: "notificationStatus = :pending",
					ExpressionAttributeValues: { ":pending": PENDING_STATUS },
					ExclusiveStartKey: exclusiveStartKey,
					Limit: limit - items.length,
				}),
			);
			items.push(...((result.Items ?? []) as SessionItem[]));
			exclusiveStartKey = result.LastEvaluatedKey;
		} while (exclusiveStartKey && items.length < limit);

		const boundary = items.at(-1);
		while (boundary && exclusiveStartKey) {
			const result = await this.client.send(
				new QueryCommand({
					TableName: this.tableName,
					IndexName: this.pendingIndexName,
					KeyConditionExpression: "notificationStatus = :pending",
					ExpressionAttributeValues: { ":pending": PENDING_STATUS },
					ExclusiveStartKey: exclusiveStartKey,
					Limit: GROUP_BOUNDARY_PAGE_SIZE,
				}),
			);
			const page = (result.Items ?? []) as SessionItem[];
			const matchingItems = page.filter((item) =>
				isSameNotificationGroup(item, boundary),
			);
			items.push(...matchingItems);

			if (matchingItems.length < page.length) break;
			exclusiveStartKey = result.LastEvaluatedKey;
		}

    // GSI propagation can lag a previous markSent. Read the base table strongly
    // before delivery so a stale index entry cannot trigger another message.
    const fresh = await this.readItems([...items.map(item => item.pk), ...this.writtenPendingPks]);
    const pending = [...fresh.values()].filter(item => item.notificationStatus === PENDING_STATUS)
      .map(item => toPendingNotification(item as unknown as SessionItem)).sort(comparePendingNotifications);
    const boundaryTitle = pending[Math.min(limit, pending.length) - 1]?.title;
    const end = pending.findIndex((item, index) => index >= limit && item.title !== boundaryTitle);
    return end < 0 ? pending : pending.slice(0, end);
	}

	async markSent(performanceIds: string[], now: string): Promise<void> {
		for (const batch of chunks(performanceIds, 100)) {
			await this.client.send(
				new TransactWriteCommand({
					TransactItems: batch.map((performanceId) => ({
						Update: {
							TableName: this.tableName,
							Key: { pk: sessionKey(performanceId) },
							UpdateExpression:
								"SET notificationState = :sent, sentAt = :now, notifiedAt = :now REMOVE notificationStatus, notificationSortKey, lastError",
							ExpressionAttributeValues: { ":sent": "sent", ":now": now },
						},
					})),
				}),
			);
		}
	}

  async discardNotification(notificationId: string, now: string): Promise<void> {
    await this.client.send(new UpdateCommand({ TableName: this.tableName, Key: { pk: sessionKey(notificationId) },
      UpdateExpression: "SET notificationState = :state, discardedAt = :now REMOVE notificationStatus, notificationSortKey",
      ExpressionAttributeValues: { ":state": "discarded", ":now": now },
    }));
  }

	async markFailed(performanceIds: string[], error: string): Promise<void> {
		for (const batch of chunks(performanceIds, 100)) {
			await this.client.send(
				new TransactWriteCommand({
					TransactItems: batch.map((performanceId) => ({
						Update: {
							TableName: this.tableName,
							Key: { pk: sessionKey(performanceId) },
							UpdateExpression:
								"SET attempts = if_not_exists(attempts, :zero) + :one, lastError = :error",
							ExpressionAttributeValues: {
								":zero": 0,
								":one": 1,
								":error": error.slice(0, 1000),
							},
						},
					})),
				}),
			);
		}
	}
}

export function createDynamoDbSessionRepository(
	tableName: string,
	client = DynamoDBDocumentClient.from(new DynamoDBClient({})),
): DynamoDbSessionRepository {
	return new DynamoDbSessionRepository(client, tableName, { knownPks: knownSessionPks });
}
