/**
 * #2125 M6b-51d-1 — keeps hand-written assignment fixtures out of the registry's way.
 *
 * Production creates an assignment under an id from `plan_assignment_ids` (`insertAssignment()`), but
 * about ninety test fixtures still `INSERT INTO user_memberships` with no id, so the legacy table's own
 * AUTO_INCREMENT hands one out. Unregistered, such an id could later be handed out again by the
 * registry and the next production insert would fail on the primary key. This registers the id of
 * every such insert, on the same connection, which also moves the registry's counter above it (an
 * explicit id does). Registering an id the writer already registered is a no-op (`INSERT IGNORE`).
 *
 * Installed once per test file by `helpers.ts`, which every DB test imports. Production code is untouched: the wrapper only adds a
 * statement after an insert into the legacy table, which only fixtures still write without an id.
 */
import { db, type QueryResult } from '../infra/db';

const LEGACY_INSERT = /^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+user_memberships\b/i;

type Query = <T = any>(sql: string, params?: any[]) => Promise<QueryResult<T>>;

function registering(query: Query): Query {
  return async <T = any>(sql: string, params: any[] = []) => {
    const result = await query<T>(sql, params);
    if (LEGACY_INSERT.test(sql) && result.insertId > 0) {
      await query(
        `INSERT IGNORE INTO plan_assignment_ids (id, gym_id)
         SELECT id, gym_id FROM user_memberships WHERE id = ?`, [result.insertId]);
    }
    return result;
  };
}

let installed = false;

export function installAssignmentIdRegistration(): void {
  if (installed) return;
  installed = true;
  const query = db.query.bind(db) as Query;
  const transaction = db.transaction.bind(db);
  db.query = registering(query) as typeof db.query;
  db.transaction = ((fn: (tx: { query: Query }) => Promise<any>) =>
    transaction((tx) => fn({ query: registering(tx.query.bind(tx) as Query) }))) as typeof db.transaction;
}
