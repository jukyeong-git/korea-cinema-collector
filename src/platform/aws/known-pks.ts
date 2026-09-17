// Cache only confirmed existence; notification state always comes from DynamoDB.
export class KnownPks {
	private readonly entries = new Map<string, number>();

	constructor(
		private readonly ttlMs = 15 * 60_000,
		private readonly maxEntries = 10_000,
	) {}

	has(tableName: string, pk: string): boolean {
		const key = JSON.stringify([tableName, pk]);
		const expires = this.entries.get(key);
		if (expires === undefined) return false;
		if (expires <= Date.now()) {
			this.entries.delete(key);
			return false;
		}
		return true;
	}

	add(tableName: string, pk: string): void {
		const key = JSON.stringify([tableName, pk]);
		this.entries.delete(key);
		this.entries.set(key, Date.now() + this.ttlMs);
		while (this.entries.size > this.maxEntries) {
			this.entries.delete(this.entries.keys().next().value!);
		}
	}
}

// Survives repository recreation in a warm Lambda execution environment.
export const knownSessionPks = new KnownPks();
