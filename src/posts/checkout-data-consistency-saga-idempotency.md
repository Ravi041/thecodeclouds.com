---
title: "Data consistency at checkout: SQL vs NoSQL, sagas, idempotent payments and stock that never oversells"
description: "How to keep checkout correct across microservices: which database each service should use, the outbox pattern, an orchestrated saga with compensations, idempotency keys that stop double charges, inventory reservations that stop oversells, and what to do when the payment gateway times out. Four editable draw.io diagrams included."
date: 2026-11-20T04:03:00Z
category: Cloud & DevOps
coverLabel: "Charge once.\nSell once.\nEven on retry."
coverCode: "Idempotency-Key · saga · outbox"
coverMotif: queue
coverImage: /assets/images/covers/checkout-data-consistency-saga-idempotency.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Charge once. Sell once. Even on retry.', with a queue illustration."
---
The first time most teams learn about distributed data is from a support ticket. A customer was charged twice for one order. Or two people bought the last pair of trainers and one of them got a "sorry, we oversold" email the next morning. Or the payment went through, the order page spun forever, and the customer has no idea whether they've paid.

None of those are exotic bugs. They're what happens by default when checkout is spread across services that each own their own data, the network sometimes drops a response, and people press the button again. In a monolith with one database you got a transaction for free. Once cart, inventory, orders and payments are separate services, and the payment itself lives at a third party, there is no transaction that spans all of it. You have to design for consistency on purpose.

This is the third article in a series on designing an online store. This one is about the data: which database each checkout service should use, how to move a checkout through several services without a global transaction, and the specific failure scenarios that cause double charges, oversells and lost orders, with the fix for each. There are four diagrams, each one an editable `.drawio` file you can download at the end.

<figure class="diagram wide"><a href="/assets/diagrams/checkout-data-consistency/checkout-hld.svg" title="Open the full-size diagram"><img src="/assets/diagrams/checkout-data-consistency/checkout-hld.svg" alt="Checkout architecture. A shopper's web or mobile app calls an API gateway that handles auth and rate limiting and requires an Idempotency-Key, which forwards POST /checkout to the checkout service, a saga orchestrator with its own PostgreSQL saga state table holding one row per checkout. The orchestrator makes sync calls with a 2 second deadline, retried with the same key, to five services, each with its own store: cart service on Redis (key-value, 7 day TTL, losing a cart is cheap), catalog and pricing on a document database plus search index (flexible attributes, read heavy), inventory on PostgreSQL (stock and reservations, conditional updates, no oversell), order service on PostgreSQL (orders and outbox, multi-row ACID), and payment service on PostgreSQL (idempotency keys and ledger, exactly one charge). The payment service calls an external payment gateway (PSP) for authorize, capture and refund with the same key on every retry, and receives webhooks back. An hourly reconciler compares the PSP report with the ledger and fixes unknown payments. Inventory, order and payment databases publish committed rows through an outbox relay to an event broker (Kafka, Pub/Sub, Service Bus or EventBridge). The broker feeds email and SMS, fulfilment, the search indexer and analytics, and clears the cart on OrderPlaced. Consumers dedupe on event id because the broker delivers at least once." width="1500" height="860" loading="lazy"></a><figcaption>The checkout services, the store each one owns, and the two ways data leaves a service: a sync call with a key, or an event through the outbox.</figcaption></figure>

## The short version

- **Each service owns its data, and nobody reads anyone else's tables.** That's what makes the services independently deployable. It's also why you need everything below.
- **Use a relational database where money and stock live.** Orders, inventory and payments need multi-row transactions, unique constraints and conditional updates. A key-value store is fine for carts and sessions; a document store with a search index suits the catalog.
- **Never write to your database and publish an event as two separate steps.** Write the event to an outbox table in the same transaction, and let a relay publish it.
- **Run checkout as an orchestrated saga.** A sequence of local transactions, each with a compensation, driven by a checkout service that saves its state before every call.
- **Every request that moves money or stock carries an idempotency key**, from the app all the way to the payment gateway. A retry with the same key gets the first answer back.
- **Reserve stock with one conditional UPDATE, and give the reservation an expiry.** Read-then-write is how you oversell.
- **A timeout is "unknown", not "failed".** Ask the payment gateway what happened before you refund, retry or cancel anything.
- **Reconcile.** An hourly job that compares the gateway's records with your ledger catches what every other mechanism missed.

## Why checkout is where consistency breaks

Browsing a store is forgiving. If the product page shows a price that's two seconds stale, or a review count that's a few behind, nobody notices. Checkout is different because it changes four things that have to agree with each other:

1. **The order** has to exist, with the right items and the right price.
2. **The stock** has to go down by exactly the quantity sold, and never below zero.
3. **The money** has to be taken exactly once.
4. **The cart** has to be emptied, and only after the order exists.

In a single database that's one `BEGIN … COMMIT`. Across services it isn't, and you can't fix that by reaching for a distributed transaction. Two-phase commit across your own services couples them at runtime: if inventory is slow, payments holds locks waiting for it. And the most important participant, the payment gateway, doesn't take part in your transactions at all. It's an HTTP API on someone else's network. So the design has to accept that, for a short window, the four things will disagree, and make sure they always end up agreeing.

That's what "eventual consistency" means in practice here. Not "it'll probably be fine", but "every path through the system, including the failures, ends in a correct state, and we can prove it from the data".

## Choosing a database for each service

The SQL vs NoSQL argument usually happens at the wrong level. You don't choose one for "the platform". You choose per service, based on what that service has to guarantee and how it's read.

| Service | Store I'd pick | Why |
|---|---|---|
| Cart | Redis, or DynamoDB / Firestore / Cosmos DB | Key-value by cart id, heavy writes, TTL for abandoned carts. Losing one is annoying, not costly. |
| Catalog and pricing | Document database plus a search index | Products have wildly different attributes. Read-heavy, cache-friendly, searched more than queried. |
| Inventory | PostgreSQL / MySQL (or a NoSQL store with conditional writes) | Needs an atomic "decrement only if enough is left". Reservations and stock must change together. |
| Orders | PostgreSQL / MySQL | An order and its lines are written together. Finance and support want joins and reports. |
| Payments | PostgreSQL / MySQL | Unique constraints on idempotency keys, an append-only ledger, and an audit trail you can defend. |
| Checkout orchestrator | PostgreSQL / MySQL | One row per checkout, updated step by step. Needs "find everything stuck for 30 seconds". |

A few notes on those choices:

**Relational is the safe default for anything with money.** Not because NoSQL can't be correct (DynamoDB conditional writes and transactions, Cosmos DB with strong consistency on a single partition, and Spanner are all used for payments), but because PostgreSQL gives you the three things you'll lean on constantly here: `UNIQUE` constraints, `UPDATE … WHERE` that checks and changes in one atomic step, and transactions across several rows. If you pick a NoSQL store for inventory or payments, make sure you can name the exact feature that replaces each of those, and design your keys so the rows that change together live in the same partition.

**The cart is the one place I'd trade durability for speed.** Redis with a TTL, or a key-value table with expiry, is fine. The cart is a wish list until checkout starts. When checkout starts, take a snapshot of it (items, quantities, prices) into the order. Never let later services read the live cart, because the shopper can still change it in another tab.

**Prices are a snapshot, not a lookup.** The catalog can change a price at any time. The order stores the price the shopper agreed to. If you want to protect against stale prices, give the checkout a quote with an expiry (say 15 minutes) and re-price only if it has expired.

**Read replicas don't belong in the checkout path.** A replica a few hundred milliseconds behind is fine for "my orders" pages. It is not fine for "is there still stock?" or "has this key been used?". Those reads go to the primary.

## The dual-write problem, and the outbox

Here's a bug that hides in almost every first version. The order service does this:

```python
db.execute("INSERT INTO orders ...")
db.commit()
broker.publish("OrderPlaced", order)   # what if the pod dies right here?
```

If the process crashes, gets OOM-killed or loses its connection to the broker between those two lines, the order exists but nobody hears about it. No confirmation email, no fulfilment, the cart is never cleared. Swap the order of the lines and you get the opposite: an event for an order that was rolled back.

The fix is the **transactional outbox**. Write the event into a table in the same database, in the same transaction, as the business change:

```sql
BEGIN;
INSERT INTO orders (id, customer_id, status, total) VALUES ($1, $2, 'CONFIRMED', $3);
INSERT INTO order_lines (order_id, sku, qty, unit_price) VALUES ...;
INSERT INTO outbox (id, aggregate_id, type, payload, created_at)
VALUES (gen_random_uuid(), $1, 'OrderConfirmed', $4, now());
COMMIT;
```

Now the order and the event are either both there or both not. A separate relay reads the outbox and publishes to the broker. It can poll (`SELECT … FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`), or tail the database's change log with a CDC tool like Debezium, which is lower latency and doesn't load the table. Either way, the relay can crash between publishing and marking the row as sent, so it will occasionally publish the same event twice. That's fine, as long as consumers expect it, which is the next point.

**Consumers have to be idempotent too.** Brokers deliver at least once: Kafka on a rebalance, SQS and Pub/Sub on a visibility timeout or a missed ack. Every consumer keeps a small "inbox" of event ids it has processed, and checks it in the same transaction as the side effect:

```sql
BEGIN;
INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING;
-- 0 rows inserted? We've done this one already: COMMIT and ack.
UPDATE ... ;  -- the actual side effect
COMMIT;
```

For side effects you can't put in a transaction, like sending an email, use the event id as the provider's idempotency or dedup key if it has one, or accept that a rare duplicate email is cheaper than a missed one.

## The checkout saga

A saga is the old idea (from a 1987 paper by Garcia-Molina and Salem) of splitting one long transaction into a series of local transactions, each with a compensating action that semantically undoes it. If step 4 fails, you run the compensations for steps 3, 2 and 1, in that order.

<figure class="diagram wide"><a href="/assets/diagrams/checkout-data-consistency/checkout-saga.svg" title="Open the full-size diagram"><img src="/assets/diagrams/checkout-data-consistency/checkout-saga.svg" alt="The checkout saga as six steps. Compensable steps, in green: 1 create order in the order service with status PENDING, 2 reserve stock in the inventory service with a hold that expires in 15 minutes, 3 authorize payment in the payment service so money is held but not taken. A dashed pivot line follows step 3. Retriable steps after the pivot, in blue: 4 confirm order with status CONFIRMED, 5 commit reservation so the hold becomes an allocation, 6 capture payment when the parcel ships. Below steps 1 to 3 are compensations, run in reverse order: C3 void authorization only if the PSP says AUTHORIZED, C2 release stock if still held, C1 cancel order and tell the shopper. A payment that is declined, flagged for fraud or out of retries triggers the compensations. A payment with no answer in 2 seconds goes to an orange box: state PAYMENT_UNKNOWN, ask the PSP by idempotency key, then go forward or compensate. A saga state table shows rows with checkout id, step, status, attempts and updated at, including one IN_PROGRESS, one DONE, one COMPENSATING and one UNKNOWN, and notes that a recovery worker replays steps stuck IN_PROGRESS for over 30 seconds with the same key. A rules panel lists: save the step then call; every step and compensation is idempotent; a timeout is unknown, not failed; nothing irreversible before the pivot; shoppers see PENDING and get email only on CONFIRMED; alert on sagas older than 10 minutes." width="1500" height="760" loading="lazy"></a><figcaption>Steps left of the pivot can be undone. Steps right of it can only be retried, so they must not be able to fail for business reasons.</figcaption></figure>

### Orchestration or choreography

There are two ways to run a saga.

**Choreography:** each service listens for the previous service's event and does its part. Order publishes `OrderCreated`, inventory hears it and publishes `StockReserved`, payments hears that and publishes `PaymentAuthorized`, and so on. There's no central coordinator, which feels elegant with two or three steps.

**Orchestration:** one service, here the checkout service, tells each participant what to do and records where it got to.

For checkout I'd use orchestration every time. The flow has six steps and four failure branches, and with choreography that logic is smeared across five codebases. When a customer asks "where's my order?" at 3 a.m., you want one row in one table that says `ck_8815, AUTHORIZE_PAYMENT, UNKNOWN, attempts 3`. With choreography you're stitching together logs from five services. Orchestration is also how tools like Temporal, AWS Step Functions, Google Cloud Workflows and Azure Durable Functions model this, if you'd rather not build the state machine yourself.

### The pivot

The most useful idea in saga design is the **pivot step**. Steps before it can be compensated. Steps after it can't, so they must be retried until they succeed. That means anything after the pivot must not be able to fail for a business reason, only for transient ones.

In the diagram, the pivot sits after "authorize payment". Authorizing only puts a hold on the card, and a hold can be voided, so steps 1 to 3 are all undoable. Once the order is confirmed (step 4), the customer has been told it's theirs. From there, committing the reservation and capturing the payment are retried forever if they have to be. They can't legitimately fail: the stock is already reserved and the money is already authorized.

This is also why you **authorize at checkout and capture at shipment**, which most card schemes and gateways support. It moves the irreversible part, taking the money, to after you're certain you can fulfil the order. A refund after capture is a compensation too, but it costs you fees, shows up on the customer's statement as two lines, and generates support tickets. A void before capture is invisible.

### Save the step, then call

The orchestrator's loop is simple, but the order of operations matters:

```python
def run(checkout_id):
    saga = load(checkout_id)                  # one row in saga_state
    while not saga.finished:
        step = saga.next_step()
        saga.mark(step, "IN_PROGRESS")        # 1. commit this first
        try:
            result = step.call(key=f"{checkout_id}:{step.name}", deadline=2.0)
            saga.mark(step, "DONE", result)   # 2. then record the outcome
        except Declined as e:
            saga.start_compensation(reason=e)
        except (Timeout, ConnectionError):
            saga.mark(step, "UNKNOWN")        # 3. never assume failure
            return schedule_retry(checkout_id)
```

Three things make that safe:

- **The state is saved before the call.** If the pod dies mid-call, a recovery worker finds the row stuck `IN_PROGRESS` for more than 30 seconds and runs the step again.
- **Running a step again is harmless,** because every call carries a key derived from the checkout and the step (`ck_8815:AUTHORIZE_PAYMENT`). The participant recognises the key and returns its earlier result.
- **Compensations are idempotent and conditional.** "Release stock" only releases a reservation that's still `HELD`. "Void authorization" first asks the gateway whether the authorization exists. Running either twice does nothing the second time.

## Scenario 1: the double charge on retry

This is the classic. The shopper taps Pay. The payment goes through at the gateway. Then the response is lost: the phone goes into a tunnel, the load balancer's idle timeout fires, or the user switches apps and the OS kills the request. The app shows an error, so the shopper taps Pay again. Or your own retry middleware does it for them, three times, with exponential backoff.

Without protection, every one of those is a new charge.

<figure class="diagram wide"><a href="/assets/diagrams/checkout-data-consistency/checkout-idempotency.svg" title="Open the full-size diagram"><img src="/assets/diagrams/checkout-data-consistency/checkout-idempotency.svg" alt="Sequence diagram with four lifelines: shopper app, payment service, payments database idempotency_keys table, and payment gateway (PSP). Attempt 1: the app sends POST /payments with Idempotency-Key 7f3c and £79.99. The payment service inserts the key with request hash and status STARTED, and the database confirms the insert, so this request owns the key. The service authorizes £79.99 at the PSP with the same idempotency key and gets back AUTHORIZED with auth id pi_91X. A note says the PSP also dedupes on the key in case we retry. The service updates the row to SUCCEEDED with the stored response. The 201 Created response back to the app is lost, marked with a red cross, because of a tunnel, the app being killed or a load balancer timeout. Attempt 2: three seconds later the app retries with the same key. The insert hits the conflict and inserts zero rows, the database returns the existing row with status SUCCEEDED and the same request hash, and the service replays the stored 201 Created response. The PSP is not called, so there is one charge. A side panel lists what the key row decides: STARTED and under 30 seconds old returns 409 still processing, retry in 1 second; STARTED and stale means take over by asking the PSP for the key first; SUCCEEDED or FAILED replays the stored response; the same key with a different body returns 422 because key reuse is a client bug. The table definition has columns key (primary key), merchant id, request hash, status, response, locked at and created at, kept for 24 to 72 hours. A note says the client makes the key once per checkout attempt, before the first tap, and stores it with the cart so a reload reuses it." width="1500" height="900" loading="lazy"></a><figcaption>The retry gets the first response back. The payment gateway is called once, and would dedupe even if we called it again.</figcaption></figure>

The fix is an **idempotency key**: a unique id for "this attempt to pay", created by the client before the first tap and sent with every retry of that attempt. The pattern is the one Stripe popularised and most gateways now support, and the server side looks like this:

```sql
-- 1. Try to claim the key. The PRIMARY KEY makes this atomic.
INSERT INTO idempotency_keys (key, merchant_id, request_hash, status, locked_at)
VALUES ($1, $2, $3, 'STARTED', now())
ON CONFLICT (key) DO NOTHING
RETURNING key;
```

- **One row inserted:** this request owns the key. Call the gateway, passing the same key as the gateway's own idempotency key, then store the outcome and the exact response body.
- **Zero rows inserted:** someone has been here before. Read the row and decide from its status, as in the panel on the right of the diagram. If it finished, replay the stored response, byte for byte. If it's still running, return `409` and let the client retry shortly. If the stored `request_hash` doesn't match the new body, return `422`: the client reused a key for a different payment, and that's a bug you want to hear about.

Some details that matter more than they look:

- **The client generates the key, not the server.** Only the client knows whether two requests are "the same attempt". Generate it when the checkout page loads, store it with the cart, and reuse it across reloads. A new key should mean the shopper genuinely wants to pay again, for example after changing the basket.
- **Pass the key through to the gateway.** Your own table protects you from your callers. The gateway's idempotency protects you from yourself, when your service crashes after calling the gateway but before writing `SUCCEEDED`.
- **Scope keys** to the merchant or customer so one tenant's key can't collide with another's, and expire them after a day or three. After that a retry is almost certainly a new intent.
- **Disable the double tap in the UI too,** but never rely on it. The button isn't the only thing that retries. Mobile HTTP clients, service meshes and SDKs all retry on their own.

## Scenario 2: the last item, sold twice

One pair of trainers left. Two shoppers press Pay 40 milliseconds apart. Both checkouts reach the inventory service at almost the same moment.

<figure class="diagram wide"><a href="/assets/diagrams/checkout-data-consistency/checkout-inventory.svg" title="Open the full-size diagram"><img src="/assets/diagrams/checkout-data-consistency/checkout-inventory.svg" alt="Two sequence diagrams side by side and a lifecycle below. Left, labelled wrong, read then check in code then write: shopper A and shopper B both SELECT available from stock row sku-123 and both get 1, both send UPDATE available = 0, and both get order placed. A red box says two orders for one unit, someone gets a sorry email, and that SERIALIZABLE isolation fixes it but aborts and retries under load. Right, labelled right, let the database do the check atomically: shopper A sends UPDATE where on_hand minus reserved is at least 1 and gets 1 row, reserved. Shopper B sends the same UPDATE, waits on the row lock, and gets 0 rows, sold out. The SQL shown is BEGIN, UPDATE stock SET reserved = reserved + qty WHERE sku matches AND on_hand - reserved >= qty, roll back and tell the shopper if 0 rows, INSERT INTO reservations with id, sku, qty, checkout id and expires_at of now plus 15 minutes, COMMIT. Below, the reservation lifecycle: Available, computed as on_hand minus reserved, goes to HELD on reserve (saga step 2) with expires_at in 15 minutes. HELD goes to COMMITTED when the order is confirmed (step 5), where on_hand and reserved both drop by qty, and then to SHIPPED with pick, pack and payment capture. HELD goes to RELEASED if payment fails (compensation C2), or to EXPIRED when a sweeper running every minute finds expires_at before now and status still HELD. Released and expired stock returns to the pool. A note says release and expiry both use WHERE status = HELD, so they can race safely and only one changes the row." width="1500" height="900" loading="lazy"></a><figcaption>Read-then-write lets both shoppers win. One conditional UPDATE lets exactly one win, and the reservation's expiry gives the stock back if the checkout dies.</figcaption></figure>

The bug on the left is a check in application code: read the stock, see it's 1, decide it's fine, write 0. Under the default isolation level of most databases (READ COMMITTED), both transactions read 1 before either writes. Both pass the check. You can fix it by raising the isolation level to SERIALIZABLE, or with `SELECT … FOR UPDATE`, but the simpler fix is to stop checking in code. **Put the check in the `WHERE` clause** and let the row lock do the work:

```sql
UPDATE stock
   SET reserved = reserved + :qty
 WHERE sku = :sku
   AND on_hand - reserved >= :qty;
```

The second transaction waits for the first one's lock, re-evaluates the condition against the committed row, finds it false, and updates zero rows. Zero rows means sold out. No race, no retry loop, and it's one round trip. The same idea exists in every serious store: DynamoDB's `ConditionExpression`, Cosmos DB's optimistic concurrency with ETags, Firestore transactions, Redis `DECRBY` inside a Lua script that checks first.

### Reserve, don't decrement

Notice the update touches `reserved`, not `on_hand`. At checkout you don't know yet whether the payment will succeed, so you **reserve** the stock instead of selling it. The reservation is a row with an expiry:

- **HELD** when the saga reserves it (step 2). It counts against availability, so nobody else can buy that unit.
- **COMMITTED** when the order is confirmed (step 5). Now `on_hand` and `reserved` both go down.
- **RELEASED** when the saga compensates, because the payment was declined.
- **EXPIRED** when nobody came back for it. A sweeper runs every minute and releases anything `HELD` past its `expires_at`.

The expiry is what saves you from the failure nobody plans for: the checkout that simply stops. The shopper closes the tab on the 3-D Secure page, or the orchestrator's pod is evicted and its recovery worker is down too. Without an expiry, that stock is locked forever and your "sold out" page is lying.

Release and expiry can race with each other, and with commit. Make each of them conditional on the current state (`UPDATE reservations SET status = 'RELEASED' WHERE id = $1 AND status = 'HELD'`) and only one of them will ever change the row. Check the affected row count before you touch the `stock` table.

### When the row gets hot

A single row per SKU is fine until a flash sale, when ten thousand people hit the same row in the same second and they all queue on its lock. That's a different problem, with answers like splitting stock across several bucket rows, gating with an in-memory counter in front of the database, and queue-based checkout. It's the subject of the next article in this series, on caching, search and flash sales.

## Scenario 3: the payment gateway times out

Your payment service calls the gateway to authorize £79.99. Two seconds pass, the deadline fires, and the connection is closed. Did the authorization happen?

You don't know. And the worst thing you can do is guess. If you assume it failed and tell the shopper to try again with a new key, you may charge them twice. If you assume it failed and compensate (cancel the order and release the stock), you may have taken money for an order that no longer exists. Both happen in real systems, and both come from treating a timeout as a failure.

The rule is: **a timeout is a third outcome, UNKNOWN.** Handle it in this order:

1. **Record it.** The saga step goes to `UNKNOWN`, not `FAILED`. The shopper sees "we're confirming your payment", not an error.
2. **Retry with the same key.** Because the gateway dedupes on your idempotency key, a retry either performs the authorization or returns the result of the one that already happened. Most of the time this resolves it in a second or two.
3. **If retries are exhausted, ask.** Most gateways let you look up a payment by your reference or idempotency key. Query it. If it says authorized, move the saga forward. If it says there's no such payment, now you can treat it as failed and compensate.
4. **Listen for the webhook.** Gateways send asynchronous notifications for authorizations, captures and disputes. Treat them as another input to the same state machine, with the same rules: dedupe on the event id, and never let an older event overwrite a newer state (store the gateway's event timestamp or sequence and ignore anything older).
5. **Reconcile.** Some payments will stay unknown no matter what: the gateway's API was down, the webhook was lost. An hourly job downloads the gateway's settlement or transaction report and compares it line by line with your ledger. Anything in their report but not in yours, or the other way round, raises an alert and, for the clear-cut cases, is fixed automatically.

The reconciler sounds like a back-office chore. It's the most important safety net in the whole design, because it's the only part that doesn't trust your own code to have been right.

## Scenario 4: the orchestrator dies mid-checkout

The checkout pod is evicted during a node upgrade, right after it sent "authorize payment" and before it recorded the answer. On the next start, nothing is holding that checkout in memory.

This is the case the "save the step, then call" rule exists for. The saga row says `AUTHORIZE_PAYMENT, IN_PROGRESS`, last updated 40 seconds ago. A recovery worker, which is just a scheduled query, picks up every row stuck `IN_PROGRESS` for longer than the step's deadline plus a margin, and resumes it. Resuming means calling the same step again with the same key, which is safe because every participant is idempotent. Use `SELECT … FOR UPDATE SKIP LOCKED` or a lease column so two workers never resume the same checkout at once.

The same mechanism covers the slower failure, where the orchestrator is up but a participant has been down for ten minutes. The saga just keeps retrying with backoff, the stock stays reserved (until its expiry), and the shopper sees a pending order. Alert on sagas older than about ten minutes; that's almost always a participant that's down or a bug in a compensation.

## Scenario 5: the price changed while they were paying

A shopper adds a TV at £499. Marketing ends the promotion at noon. The shopper pays at 12:01. What do they pay?

Whatever you decide, decide it explicitly. The pattern I'd recommend is a **checkout quote**: when checkout starts, the order service snapshots the line items and prices into the order (status `PENDING`) with a `price_valid_until` 15 minutes ahead. The payment amount comes from the order, never from a fresh catalog lookup. If the quote has expired by the time they pay, re-price, show the new total, and ask them to confirm. That way the amount you authorize always matches a price the shopper actually saw, and the catalog team can change prices without breaking checkouts that are in flight.

## What to measure

You can't eyeball consistency. These are the numbers worth a dashboard and, for the first four, an alert:

- **Sagas in a non-final state, by age.** Anything over ten minutes is a problem. A growing count is an outage in a participant.
- **Payments in `UNKNOWN`,** and how long they stay there.
- **Reconciliation mismatches** per run. This should be zero almost every hour.
- **Outbox lag:** the age of the oldest unpublished row. If the relay stops, events stop, and nothing else will tell you.
- **Idempotent replays** (requests answered from a stored response). A sudden jump means a client or a proxy is retrying more than it should.
- **Reservation expiries vs commits.** A high expiry rate means checkouts are being abandoned or are failing silently somewhere.
- **Oversell count:** orders confirmed where the allocation later failed. With the design above this should be zero; if it isn't, someone is writing to stock outside the conditional update.

## How to test it

The happy path will work on day one. The bugs are all in the timing, so test the timing on purpose:

- **Kill the orchestrator** at every step of the saga in a test environment (a fault-injection hook that exits the process after "save step" and before "record result" is enough) and check every checkout still ends correctly.
- **Inject gateway timeouts** where the gateway did process the request. Most gateways' test modes, or a stub in front of them, let you delay the response past your deadline.
- **Deliver every event twice** in tests. If anything changes the second time, a consumer isn't idempotent.
- **Race the last unit.** Fire 50 concurrent checkouts at a SKU with 1 in stock and assert exactly one order is confirmed.
- **Replay a payment request with a different body** and the same key, and check you get a `422`, not a second charge.

## Checklist

- Each checkout service has its own database, and no service reads another's tables
- Orders, inventory and payments on a store with unique constraints, conditional updates and multi-row transactions
- Every event written to an outbox in the same transaction as the change; a relay or CDC publishes it
- Every consumer dedupes on event id in the same transaction as its side effect
- Checkout runs as an orchestrated saga with a state table; state saved before every call
- A pivot step: authorize before it, capture after it
- Every step and every compensation is idempotent and conditional on current state
- Client-generated idempotency keys on every payment request, passed through to the gateway
- Stock reserved with a single conditional UPDATE, never read-then-write
- Reservations expire, and a sweeper releases them
- Timeouts recorded as UNKNOWN and resolved by retrying with the same key or querying the gateway
- Webhooks deduped and ordered by the gateway's own timestamps
- An hourly reconciler against the gateway's reports, with alerts on mismatches
- Alerts on stuck sagas, unknown payments, outbox lag and reconciliation mismatches

## Download the diagrams

All four diagrams are editable draw.io files. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and rename the services, stores and timings to match your platform.

- [All four diagrams in one file (4 pages)](/assets/diagrams/checkout-data-consistency/checkout-data-consistency.drawio)
- [Checkout architecture: one store per service](/assets/diagrams/checkout-data-consistency/checkout-hld.drawio)
- [The checkout saga and its compensations](/assets/diagrams/checkout-data-consistency/checkout-saga.drawio)
- [Idempotent payment on retry](/assets/diagrams/checkout-data-consistency/checkout-idempotency.drawio)
- [Inventory reservation without oversell](/assets/diagrams/checkout-data-consistency/checkout-inventory.drawio)

The timings (2 second deadlines, 15 minute holds, 30 second recovery) are sensible starting points, not rules. Tune them against your own gateway's latency and your shoppers' behaviour.

## References

- [Hector Garcia-Molina and Kenneth Salem, "Sagas" (1987)](https://dl.acm.org/doi/10.1145/38713.38742)
- [Pattern: Saga](https://microservices.io/patterns/data/saga.html) and [Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html), microservices.io
- [Idempotent requests, Stripe API reference](https://docs.stripe.com/api/idempotent_requests)
- [PostgreSQL: INSERT … ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT) and [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Amazon DynamoDB condition expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html)
- [Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
