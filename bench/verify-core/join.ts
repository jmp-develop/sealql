/** Disposable fixture-derived 1:N JOIN and keyset checks; no timing. */
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { withNativeFixture } from './native-fixture.js';

await withNativeFixture('verify_native_join', async ({ db, sealed, customers, customersSeal, ticketTable, ticketsSeal,
  customer, other, tickets, scopeId }: any) => {
  const match = {
    c: [customersSeal, (m: any) => m.or(m.name.eq(customer.name_plain), m.name.eq(other.name_plain))],
    t: [ticketsSeal, (m: any) => m.or(m.memo.contains(tickets[0].memo_plain.slice(0, 2)),
      m.memo.contains(tickets[1].memo_plain.slice(0, 2)))],
  } as const;
  const query = ({ where, after, orderBy, flags, limit }: any) => db.select({ c: customers, t: ticketTable, ...flags })
    .from(ticketTable).innerJoin(customers, eq(ticketTable.customerId, customers.id))
    .where(and(where, after)).orderBy(...orderBy).limit(limit);
  const first = await sealed.search(db, { scope: scopeId, match, keyset: [ticketTable.id], limit: 1, query });
  assert.equal(first.items.length, 1);
  assert.ok([customer.id, other.id].includes(first.items[0].c.id));
  assert.ok(first.nextCursor);
  const second = await sealed.search(db, { scope: scopeId, match, keyset: [ticketTable.id], limit: 1,
    cursor: first.nextCursor, query });
  const all = [...first.items, ...second.items];
  assert.ok(all.length <= 2);
  assert.equal(new Set(all.map(row => row.t.id)).size, all.length);
  for (const row of all) assert.ok(tickets.some((source: any) => source.id === row.t.id));
  console.log('native JOIN checks PASS');
});
