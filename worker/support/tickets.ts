/**
 * Support ticket repository. Isolated SQL for the ticket domain — customers can
 * only ever reach their own tickets (customerId is always part of the WHERE).
 */
export interface TicketRow {
  id: string;
  customer_id: string | null;
  customer_email: string;
  subject: string;
  status: 'open' | 'pending' | 'closed';
  priority: 'low' | 'normal' | 'high';
  created_at: string;
  updated_at: string;
}

export interface TicketMessageRow {
  id: number;
  ticket_id: string;
  author: 'customer' | 'admin' | 'ai';
  body: string;
  created_at: string;
}

export async function createTicket(
  db: D1Database,
  input: { customerId: string | null; email: string; subject: string; body: string; now: string },
): Promise<TicketRow> {
  const id = `TCK-${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO support_tickets (id, customer_id, customer_email, subject, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', 'normal', ?, ?)`,
    )
    .bind(id, input.customerId, input.email.toLowerCase().trim(), input.subject, input.now, input.now)
    .run();
  await db
    .prepare(`INSERT INTO support_ticket_messages (ticket_id, author, body, created_at) VALUES (?, 'customer', ?, ?)`)
    .bind(id, input.body, input.now)
    .run();
  const row = await db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).bind(id).first<TicketRow>();
  if (!row) throw new Error('createTicket: insert failed');
  return row;
}

export async function listTicketsForCustomer(db: D1Database, customerId: string): Promise<TicketRow[]> {
  const result = await db
    .prepare(`SELECT * FROM support_tickets WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 50`)
    .bind(customerId)
    .all<TicketRow>();
  return result.results ?? [];
}

export async function listTickets(db: D1Database, status: string | null, limit = 100): Promise<TicketRow[]> {
  const query = status
    ? `SELECT * FROM support_tickets WHERE status = ? ORDER BY updated_at DESC LIMIT ?`
    : `SELECT * FROM support_tickets ORDER BY updated_at DESC LIMIT ?`;
  const stmt = status ? db.prepare(query).bind(status, limit) : db.prepare(query).bind(limit);
  const result = await stmt.all<TicketRow>();
  return result.results ?? [];
}

/** Customer access is enforced here: the ticket must belong to the customer. */
export async function getCustomerTicket(
  db: D1Database,
  customerId: string,
  ticketId: string,
): Promise<TicketRow | null> {
  return db
    .prepare(`SELECT * FROM support_tickets WHERE id = ? AND customer_id = ?`)
    .bind(ticketId, customerId)
    .first<TicketRow>();
}

export async function getTicket(db: D1Database, ticketId: string): Promise<TicketRow | null> {
  return db.prepare(`SELECT * FROM support_tickets WHERE id = ?`).bind(ticketId).first<TicketRow>();
}

export async function listTicketMessages(db: D1Database, ticketId: string): Promise<TicketMessageRow[]> {
  const result = await db
    .prepare(`SELECT * FROM support_ticket_messages WHERE ticket_id = ? ORDER BY id ASC`)
    .bind(ticketId)
    .all<TicketMessageRow>();
  return result.results ?? [];
}

export async function addTicketMessage(
  db: D1Database,
  ticketId: string,
  author: 'customer' | 'admin' | 'ai',
  body: string,
  now: string,
): Promise<void> {
  await db
    .prepare(`INSERT INTO support_ticket_messages (ticket_id, author, body, created_at) VALUES (?, ?, ?, ?)`)
    .bind(ticketId, author, body, now)
    .run();
  await db.prepare(`UPDATE support_tickets SET updated_at = ? WHERE id = ?`).bind(now, ticketId).run();
}

export async function setTicketStatus(db: D1Database, ticketId: string, status: 'open' | 'pending' | 'closed', now: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, now, ticketId)
    .run();
  const meta = result.meta as { changes?: number } | undefined;
  return (meta?.changes ?? 0) > 0;
}
