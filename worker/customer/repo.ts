/**
 * D1 repository for customer identity and order ownership.
 * Touches only `vpn_customer_*` tables plus the read-only join to `vpn_orders`.
 */
export interface CustomerRow {
  id: string;
  email_norm: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerSessionRow {
  customer_id: string;
  csrf_token: string;
  expires_at: string;
  email_norm: string;
}

export interface CustomerOrderRow {
  id: string;
  plan_id: string;
  interval_months: number;
  amount_cents: number;
  currency: string;
  order_status: string;
  payment_status: string;
  provisioning_status: string;
  subscription_status: string;
  created_at: string;
  expire_at: string | null;
}

export async function findOrCreateCustomer(db: D1Database, emailNorm: string, now: string): Promise<CustomerRow> {
  const existing = await db
    .prepare(`SELECT * FROM vpn_customers WHERE email_norm = ?`)
    .bind(emailNorm)
    .first<CustomerRow>();
  if (existing) return existing;

  const id = `CUS-${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO vpn_customers (id, email_norm, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email_norm) DO NOTHING`,
    )
    .bind(id, emailNorm, now, now)
    .run();

  const row = await db
    .prepare(`SELECT * FROM vpn_customers WHERE email_norm = ?`)
    .bind(emailNorm)
    .first<CustomerRow>();
  if (!row) throw new Error('findOrCreateCustomer: insert failed');
  return row;
}

export async function getCustomerById(db: D1Database, id: string): Promise<CustomerRow | null> {
  return db.prepare(`SELECT * FROM vpn_customers WHERE id = ?`).bind(id).first<CustomerRow>();
}

export async function insertCustomerToken(
  db: D1Database,
  token: { tokenHash: string; customerId: string; expiresAt: string; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vpn_customer_tokens (token_hash, customer_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(token.tokenHash, token.customerId, token.expiresAt, token.now)
    .run();
}

/**
 * Atomically consumes a magic-link token. The UPDATE ... WHERE used_at IS NULL
 * guarantees exactly one winner even under concurrent requests.
 */
export async function consumeCustomerToken(
  db: D1Database,
  tokenHash: string,
  now: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE vpn_customer_tokens SET used_at = ?
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      RETURNING customer_id`,
    )
    .bind(now, tokenHash, now)
    .first<{ customer_id: string }>();
  return row?.customer_id ?? null;
}

/** Links all orders with the verified email to this customer (never steals an existing link). */
export async function linkOrdersToCustomer(
  db: D1Database,
  customerId: string,
  emailNorm: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vpn_customer_orders (order_id, customer_id, linked_at)
       SELECT id, ?, ? FROM vpn_orders WHERE lower(trim(customer_email)) = ?
       ON CONFLICT(order_id) DO NOTHING`,
    )
    .bind(customerId, now, emailNorm)
    .run();
}

/** Links a single order when its email matches the verified customer email. */
export async function linkOrderByEmail(
  db: D1Database,
  customerId: string,
  emailNorm: string,
  orderId: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vpn_customer_orders (order_id, customer_id, linked_at)
       SELECT id, ?, ? FROM vpn_orders WHERE id = ? AND lower(trim(customer_email)) = ?
       ON CONFLICT(order_id) DO NOTHING`,
    )
    .bind(customerId, now, orderId, emailNorm)
    .run();
}

export async function createCustomerSession(
  db: D1Database,
  session: { tokenHash: string; customerId: string; csrfToken: string; now: string; expiresAt: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vpn_customer_sessions (token_hash, customer_id, csrf_token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(session.tokenHash, session.customerId, session.csrfToken, session.now, session.expiresAt)
    .run();
}

export async function getCustomerSession(
  db: D1Database,
  tokenHash: string,
  now: string,
): Promise<CustomerSessionRow | null> {
  return db
    .prepare(
      `SELECT s.customer_id, s.csrf_token, s.expires_at, c.email_norm
         FROM vpn_customer_sessions s JOIN vpn_customers c ON c.id = s.customer_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<CustomerSessionRow>();
}

export async function deleteCustomerSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare(`DELETE FROM vpn_customer_sessions WHERE token_hash = ?`).bind(tokenHash).run();
}

export async function listCustomerOrders(db: D1Database, customerId: string): Promise<CustomerOrderRow[]> {
  const result = await db
    .prepare(
      `SELECT o.id, o.plan_id, o.interval_months, o.amount_cents, o.currency, o.order_status, o.payment_status,
              o.provisioning_status, o.subscription_status, o.created_at, o.expire_at
         FROM vpn_orders o JOIN vpn_customer_orders m ON m.order_id = o.id
        WHERE m.customer_id = ?
        ORDER BY o.created_at DESC`,
    )
    .bind(customerId)
    .all<CustomerOrderRow>();
  return result.results ?? [];
}

/** Ownership is enforced in the query, never from a browser-supplied id alone. */
export async function getCustomerOrder(
  db: D1Database,
  customerId: string,
  orderId: string,
): Promise<CustomerOrderRow | null> {
  return db
    .prepare(
      `SELECT o.id, o.plan_id, o.interval_months, o.amount_cents, o.currency, o.order_status, o.payment_status,
              o.provisioning_status, o.subscription_status, o.created_at, o.expire_at
         FROM vpn_orders o JOIN vpn_customer_orders m ON m.order_id = o.id
        WHERE m.customer_id = ? AND o.id = ?`,
    )
    .bind(customerId, orderId)
    .first<CustomerOrderRow>();
}
