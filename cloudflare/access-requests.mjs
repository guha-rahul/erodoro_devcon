const X_USERNAME = /^@?[A-Za-z0-9_]{1,15}$/;
export const MAX_ACCESS_REQUESTS = 100_000;

export class AccessRequestCapacityError extends Error {
  constructor() {
    super("The access request list is full.");
    this.name = "AccessRequestCapacityError";
  }
}

export function normalizeXUsername(value) {
  if (typeof value !== "string" || !X_USERNAME.test(value)) return null;
  const display = value.startsWith("@") ? value.slice(1) : value;
  return { display, key: display.toLowerCase() };
}

/** Persist one request without collecting an email address or network metadata. */
export async function storeAccessRequest(db, value, now = Math.floor(Date.now() / 1000)) {
  const username = normalizeXUsername(value);
  if (!username) throw new TypeError("Invalid X username.");
  if (!db) throw new Error("Access request storage is unavailable.");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS access_requests (
      x_username TEXT PRIMARY KEY,
      display_username TEXT NOT NULL,
      first_requested_at INTEGER NOT NULL,
      last_requested_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 1
    );
  `);
  const result = await db.prepare(`
    INSERT INTO access_requests (
      x_username, display_username, first_requested_at, last_requested_at, request_count
    )
    SELECT ?1, ?2, ?3, ?3, 1
    WHERE EXISTS (
      SELECT 1 FROM access_requests WHERE x_username = ?1
    ) OR (
      SELECT COUNT(*) FROM access_requests
    ) < ${MAX_ACCESS_REQUESTS}
    ON CONFLICT(x_username) DO UPDATE SET
      display_username = excluded.display_username,
      last_requested_at = excluded.last_requested_at,
      request_count = access_requests.request_count + 1
  `).bind(username.key, username.display, now).run();

  if (result?.meta?.changes === 0) throw new AccessRequestCapacityError();
  return username;
}
