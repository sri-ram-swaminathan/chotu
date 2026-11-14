// Thin helpers over D1 so the rest of the code reads cleanly.
// D1 is SQLite: you write normal SQL with `?` placeholders. NEVER build SQL by string-concatenating
// user input — always bind parameters (this is what prevents SQL injection).

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return res.results ?? [];
}

export async function first<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

export async function kvGet(db: D1Database, key: string): Promise<string | null> {
  const row = await first<{ value: string }>(db, "SELECT value FROM kv WHERE key = ?", key);
  return row?.value ?? null;
}

export async function kvSet(db: D1Database, key: string, value: string): Promise<void> {
  await run(db, "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}
