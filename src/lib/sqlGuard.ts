// Guard for the orchestrator's read-only `sql` tool. The LLM writes the SQL, so treat it as untrusted:
// one statement, SELECT/WITH only, no write or schema keywords anywhere. (Pure — unit-tested.)
//
// Defence in depth: the query is also wrapped as `SELECT * FROM (<query>) LIMIT 50`, which SQLite
// rejects for anything that isn't a plain SELECT.

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;

/** Returns a cleaned single SELECT, or throws with a message the LLM can act on. */
export function safeSelect(sql: string): string {
  const s = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(s)) throw new Error("Only SELECT (or WITH … SELECT) queries are allowed.");
  if (s.includes(";")) throw new Error("One statement only — no semicolons.");
  if (FORBIDDEN.test(s)) throw new Error("Read-only: the query contains a write/DDL keyword.");
  return s;
}
