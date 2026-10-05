/**
 * Unit tests for who still has their welcome discount.
 *
 * The repo has no test runner wired up, so these use Node's built-in
 * `node:test` + `node:assert` (zero dependencies). Run with a TS-aware loader,
 * e.g. `node --test --import tsx lib/promos/first-order.test.ts`.
 *
 * The Supabase client is stubbed down to the two shapes `isCustomerFirstOrder`
 * actually uses: a `maybeSingle()` read of the customer row, and a counting
 * `head` select over `puramass_orders`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCustomerFirstOrder,
  WELCOME_DISCOUNT_CONSUMING_STATUSES,
} from './first-order';

interface StubOpts {
  /** The legacy flag on the customer row. */
  completedFirstOrder?: boolean | null;
  /** Rows in puramass_orders matching the consuming statuses. */
  hostedOrders?: number;
  /** Make the customers read fail. */
  customerError?: boolean;
  /** Make the puramass_orders count fail. */
  ordersError?: boolean;
}

function stubDb(opts: StubOpts = {}) {
  const statusesAsked: string[][] = [];
  const db = {
    from(table: string) {
      if (table === 'customers') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.customerError
                  ? { data: null, error: { message: 'boom' } }
                  : {
                      data: {
                        has_completed_first_order:
                          opts.completedFirstOrder ?? false,
                      },
                      error: null,
                    },
            }),
          }),
        };
      }
      if (table === 'puramass_orders') {
        return {
          select: () => ({
            eq: () => ({
              in: async (_col: string, statuses: string[]) => {
                statusesAsked.push(statuses);
                return opts.ordersError
                  ? { count: null, error: { message: 'boom' } }
                  : { count: opts.hostedOrders ?? 0, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { db: db as any, statusesAsked };
}

test('a signed-out visitor is never a first-order customer', async () => {
  const { db } = stubDb();
  assert.equal(await isCustomerFirstOrder(db, null), false);
  assert.equal(await isCustomerFirstOrder(db, undefined), false);
  assert.equal(await isCustomerFirstOrder(db, ''), false);
});

test('a customer with no orders at all still has the discount', async () => {
  const { db } = stubDb({ completedFirstOrder: false, hostedOrders: 0 });
  assert.equal(await isCustomerFirstOrder(db, 'cus_1'), true);
});

test('the legacy first-order flag spends it', async () => {
  const { db } = stubDb({ completedFirstOrder: true, hostedOrders: 0 });
  assert.equal(await isCustomerFirstOrder(db, 'cus_1'), false);
});

test('an existing hosted order spends it even when the legacy flag is unset', async () => {
  // The hosted checkout never writes has_completed_first_order, so the ledger
  // row is the only record that the order happened.
  const { db } = stubDb({ completedFirstOrder: false, hostedOrders: 1 });
  assert.equal(await isCustomerFirstOrder(db, 'cus_1'), false);
});

test('a pending hand-off counts, so the offer cannot be spent twice at once', async () => {
  const { db, statusesAsked } = stubDb({ hostedOrders: 0 });
  await isCustomerFirstOrder(db, 'cus_1');
  assert.deepEqual(statusesAsked[0], ['paid', 'payment_pending']);
});

test('abandoned checkouts do not count — expired and cancelled are excluded', async () => {
  const consuming = [...WELCOME_DISCOUNT_CONSUMING_STATUSES] as string[];
  assert.ok(!consuming.includes('expired'));
  assert.ok(!consuming.includes('cancelled'));
});

test('a failed customer read fails closed', async () => {
  const { db } = stubDb({ customerError: true });
  assert.equal(await isCustomerFirstOrder(db, 'cus_1'), false);
});

test('a failed order count fails closed', async () => {
  const { db } = stubDb({ ordersError: true });
  assert.equal(await isCustomerFirstOrder(db, 'cus_1'), false);
});

// ---------------------------------------------------------------------------
// firstOrderStatus — by customer id AND email, for first-order-only codes
// ---------------------------------------------------------------------------

import { escapeLike, firstOrderStatus, normalizeOrderEmail } from './first-order';

interface Fixture {
  customersById?: any;
  customersByEmail?: any[];
  hostedById?: any[];
  hostedByEmail?: any[];
  legacyByEmail?: any[];
  fail?: 'customers' | 'puramass_orders' | 'orders';
}

/**
 * Chainable stand-in for the query builder. Records which filter each query
 * used (`eq` for the id, `ilike` for the email) and answers from the fixture.
 */
function chainDb(f: Fixture) {
  const asked: { table: string; filter: string; value: unknown }[] = [];
  const db = {
    from(table: string) {
      let filter = '';
      let value: unknown = null;
      const answer = () => {
        if (f.fail === table) return { data: null, error: { message: 'boom' } };
        if (table === 'customers') {
          return filter === 'eq'
            ? { data: f.customersById ?? null, error: null }
            : { data: f.customersByEmail ?? [], error: null };
        }
        if (table === 'puramass_orders') {
          return { data: (filter === 'eq' ? f.hostedById : f.hostedByEmail) ?? [], error: null };
        }
        return { data: f.legacyByEmail ?? [], error: null };
      };
      const q: any = {
        select: () => q,
        eq: (_c: string, v: unknown) => {
          filter = 'eq';
          value = v;
          asked.push({ table, filter, value });
          return q;
        },
        ilike: (_c: string, v: unknown) => {
          filter = 'ilike';
          value = v;
          asked.push({ table, filter, value });
          return q;
        },
        in: () => q,
        limit: () => q,
        maybeSingle: async () => answer(),
        then: (resolve: any, reject: any) => Promise.resolve(answer()).then(resolve, reject),
      };
      return q;
    },
  };
  return { db: db as any, asked };
}

test('nobody to check is unknown, never first', async () => {
  const { db } = chainDb({});
  assert.equal(await firstOrderStatus(db, {}), 'unknown');
  assert.equal(await firstOrderStatus(db, { email: 'not an email' }), 'unknown');
});

test('a guest with no history is on their first order', async () => {
  const { db } = chainDb({});
  assert.equal(await firstOrderStatus(db, { email: 'New@Example.com' }), 'first');
});

test('a guest who paid before, as a guest, has ordered', async () => {
  const { db } = chainDb({ hostedByEmail: [{ status: 'paid' }] });
  assert.equal(await firstOrderStatus(db, { email: 'buyer@example.com' }), 'ordered');
});

test('a checkout awaiting payment does not use up a first-order code', async () => {
  // The buyer's own just-started hand-off writes this row — going back to the
  // checkout must not find it and refuse them their code.
  const { db } = chainDb({ hostedByEmail: [{ status: 'payment_pending' }] });
  assert.equal(await firstOrderStatus(db, { email: 'buyer@example.com' }), 'first');
});

test('only paid hosted orders are asked for', async () => {
  const statuses: unknown[] = [];
  const { db } = chainDb({});
  const from = db.from;
  db.from = (table: string) => {
    const q = from(table);
    if (table === 'puramass_orders') {
      const inner = q.in;
      q.in = (_c: string, v: unknown) => {
        statuses.push(v);
        return inner();
      };
    }
    return q;
  };
  await firstOrderStatus(db, { customerId: 'cus_1', email: 'b@example.com' });
  assert.deepEqual(statuses, [['paid'], ['paid']]);
});

test('paid counts even beside an unpaid checkout', async () => {
  const { db } = chainDb({
    hostedById: [{ status: 'payment_pending' }],
    hostedByEmail: [{ status: 'paid' }],
  });
  assert.equal(await firstOrderStatus(db, { customerId: 'cus_1', email: 'b@example.com' }), 'ordered');
});

test('an account under the same email with the legacy flag has ordered', async () => {
  const { db } = chainDb({ customersByEmail: [{ has_completed_first_order: true }] });
  assert.equal(await firstOrderStatus(db, { email: 'b@example.com' }), 'ordered');
});

test('a completed legacy order under the email has ordered; an unpaid one has not', async () => {
  assert.equal(
    await firstOrderStatus(chainDb({ legacyByEmail: [{ status: 'confirmed' }] }).db, { email: 'b@example.com' }),
    'ordered',
  );
  assert.equal(
    await firstOrderStatus(chainDb({ legacyByEmail: [{ status: 'pending', payment_confirmed_at: null }] }).db, {
      email: 'b@example.com',
    }),
    'first',
  );
});

test('any failed read is unknown', async () => {
  for (const fail of ['customers', 'puramass_orders', 'orders'] as const) {
    const { db } = chainDb({ fail });
    assert.equal(await firstOrderStatus(db, { customerId: 'cus_1', email: 'b@example.com' }), 'unknown');
  }
});

test('emails are matched literally and case-insensitively', async () => {
  const { db, asked } = chainDb({});
  await firstOrderStatus(db, { email: ' John_Doe%1@Example.com ' });
  const patterns = asked.filter((a) => a.filter === 'ilike').map((a) => a.value);
  assert.ok(patterns.length > 0);
  for (const p of patterns) assert.equal(p, 'john\\_doe\\%1@example.com');
  assert.equal(escapeLike('a\\b'), 'a\\\\b');
  assert.equal(normalizeOrderEmail('  X@Y.CO '), 'x@y.co');
});
