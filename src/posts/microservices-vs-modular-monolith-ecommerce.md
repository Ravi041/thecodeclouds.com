---
title: "Microservices or a modular monolith for e-commerce? Split when the team forces you to"
description: "When an online shop should stay a modular monolith and when to split into microservices: team-size signals, bounded contexts and data ownership, API gateway and BFF patterns, a checkout outage that cascaded, and a strangler-fig migration plan. Five editable draw.io diagrams included."
date: 2026-11-20T04:02:00Z
category: Cloud & DevOps
coverLabel: "Monolith or\nmicroservices?\nAsk your org chart."
coverCode: "split by team, not by noun"
coverMotif: queue
coverImage: /assets/images/covers/microservices-vs-modular-monolith-ecommerce.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Monolith or microservices? Ask your org chart.', with a row of queued request blocks."
---
Most e-commerce teams don't choose microservices. They drift into them. Someone pulls search out because it needs more memory, someone else wraps the payment provider in a service "to keep PCI scope small", and a year later checkout makes nine network calls to put one order in the database. Nobody decided that. It just happened, one reasonable pull request at a time.

The opposite drift is just as common. A shop runs on one big app long after it has fifty engineers, every release waits for a two-hour test suite, and a bad deploy to the reviews widget takes payments down with it.

This article is about choosing on purpose. It follows one fictional online shop, Kestrel Home, from five engineers to fifty, and looks at what changes at each stage: where to draw service boundaries, what an API gateway and a Backend-for-Frontend should and shouldn't do, and what happened on the sale night when one slow dependency took the whole shop offline. All five diagrams are original, editable draw.io files you can download at the end.

## The short version

- **Start with a modular monolith.** One deployable, one database, but real modules with public interfaces and a schema each. It gives you most of the design benefits of services at a fraction of the operational cost.
- **Split for a reason you can name.** Different scaling needs, a different compliance scope, or a team that is blocked by everyone else's release train. "It's cleaner" is not a reason.
- **Cut along business capabilities, not nouns.** Checkout, payments, inventory and catalog are capabilities. "Product service" and "user service" are nouns, and they end up called by everything.
- **Each service owns its data.** If two services write the same table, you have a distributed monolith: all the network problems of microservices and none of the independence.
- **The gateway handles cross-cutting concerns, the BFF shapes data for one client.** Neither should contain business rules.
- **Design for slow, not just for down.** Timeouts, deadlines, bulkheads, one place for retries, and an async tail after "Order received". That is what stops a slow fraud check from becoming an outage.

## Three shapes, one shop

Before arguing about which is better, it helps to be exact about what each shape is.

**A monolith** is one deployable unit. All the code runs in one process (scaled to as many identical replicas as you need) and usually talks to one database. That is not a problem on its own. The problem is the *big ball of mud*: a monolith where any file can call any other file and any query can join any table, so nobody can change anything safely.

**A modular monolith** is still one deployable, but the code is split into modules that match business capabilities: catalog, cart, checkout, pricing, orders, payments, inventory, customers. Each module exposes a small public interface. Other modules may call that interface and nothing else. Each module has its own schema in the shared database, and no module reads another module's tables. These rules are checked by the build, not by good intentions.

**Microservices** take the same modules and put a network between them. Each service is deployed on its own, owns its own datastore, and is owned by one team with its own pipeline, dashboards and on-call rota. Calls between services are HTTP, gRPC or events.

<figure class="diagram wide"><a href="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-monolith-vs-microservices.svg" title="Open the full-size diagram"><img src="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-monolith-vs-microservices.svg" alt="Side-by-side comparison. Left, a modular monolith: one shop-app process containing nine modules (Catalog, Search, Customers, Cart, Checkout, Pricing and promos, Inventory, Orders, Payments), each with a public interface only. Checkout calls Cart, Pricing, Inventory, Orders and Payments in-process. Below it, one PostgreSQL cluster with a schema per module. A rules box says modules talk only through public interfaces, boundaries are checked in CI, each module has an owner in CODEOWNERS, and events leave through an outbox. Right, microservices: an API gateway in front of Catalog, Search, Cart and Checkout services, each with its own datastore. Checkout makes synchronous HTTP or gRPC calls to Pricing, Inventory and Payments. Orders, Pricing, Inventory and Payments publish events to an event bus such as Kafka, Pub/Sub, Service Bus or EventBridge. A box lists what you sign up for: per-service deploys, dashboards, on-call, no cross-service transactions, contract tests, and platform needs like service discovery, mTLS and tracing." width="1500" height="800" loading="lazy"></a><figcaption>The same business modules in both shapes. The difference is whether boundaries are enforced in code or by the network.</figcaption></figure>

Look at the two halves of that diagram and notice what is *the same*. The boxes are identical. The hard part of both designs is deciding what the boxes are and what each one is allowed to know. If you get that right in a monolith, extracting a service later is a few weeks of work. If you get it wrong in microservices, you have the same mess, except now every mistake is a network call.

There is a fourth shape worth naming because it is the one people end up with by accident: **the distributed monolith**. Services that must be deployed together, share a database, or can't serve a request unless five other services are up. It has the costs of microservices and the coupling of a monolith. Most "our microservices migration failed" stories are really about this.

## Scenario: Kestrel Home grows from 5 to 50 engineers

Kestrel Home sells furniture and homeware online. Here is how its architecture changed, and more importantly *why* it changed each time.

<figure class="diagram wide"><a href="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-team-growth-5-to-50.svg" title="Open the full-size diagram"><img src="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-team-growth-5-to-50.svg" alt="Three stages left to right. Stage 1, year 1, 5 engineers: one team, one app, one deployable that ships ten times a day, one database where joins and transactions are free, folders not modules. Pain that ends it: merge conflicts in checkout, a 25 minute test suite, one person who owns payments in their head. Stage 2, year 2, 15 to 20 engineers: three teams (Discover, Buy, Fulfil) in the same deployable with real modules, a schema per module and CODEOWNERS plus CI boundary checks. Pain that ends it: search needs 40 nodes at sale time while the rest needs 6, PCI scope covers the whole app, and the deploy queue reaches two hours. Stage 3, year 3 and later, 50 engineers: seven teams, a modular core for catalog, cart, checkout and orders, extracted services for search, payments and inventory, behind a gateway with an event bus and strangler routing per path. Note: extract only where there is a reason, everything else stays in the core." width="1500" height="760" loading="lazy"></a><figcaption>Architecture follows the team. Each stage fixes the problem the previous stage created.</figcaption></figure>

### Stage 1: five engineers, one app

Year one is a single Django app (it could just as well be Rails, Laravel or Spring Boot) on a managed PostgreSQL database. Five engineers, one backlog, one pipeline. They deploy ten times a day. A new promotion type takes an afternoon because the promotion code, the cart and the order table are all right there, and a single database transaction keeps them consistent.

Microservices at this stage would have been pure cost. With five people, every service is owned by "everyone", which means nobody. You would spend your first six months building deployment pipelines, service discovery and distributed tracing for a product that hasn't found its customers yet.

What ended stage 1 wasn't scale. It was **people stepping on each other**:

- Three people were changing checkout in the same week, and merges kept breaking it.
- The test suite took 25 minutes because every test booted the whole app and touched the shared database.
- One engineer understood the payments code. When they went on holiday, payment changes stopped.

### Stage 2: fifteen to twenty engineers, real modules

The fix was not microservices. It was **modules with teeth**. The team split into three: Discover (catalog, search), Buy (cart, checkout, orders, pricing) and Fulfil (inventory, shipping). The code was reorganised into one top-level package per module, and each module got:

- A public interface (a Python package `shop.checkout.api`, a Java package, a Ruby pack) and an `internal` package nobody else may import.
- Its own database schema. `orders.*` tables belong to the orders module. If checkout needs order data, it calls `orders.api.get_order()`. No cross-schema joins.
- An owner in `CODEOWNERS`, so a change to `shop/payments/` needs a review from the payments people.
- Tests that run per module, so changing catalog runs catalog's tests, not all 4,000.

The boundary rules were enforced in CI. In Python that's [import-linter](https://import-linter.readthedocs.io/):

```ini
# .importlinter
[importlinter]
root_package = shop

[importlinter:contract:payments-internals]
name = Only payments may import payments internals
type = forbidden
source_modules =
    shop.checkout
    shop.orders
    shop.cart
forbidden_modules =
    shop.payments.internal

[importlinter:contract:catalog-does-not-know-checkout]
name = Catalog never depends on checkout
type = forbidden
source_modules =
    shop.catalog
forbidden_modules =
    shop.checkout
```

In a Spring Boot app, [Spring Modulith](https://spring.io/projects/spring-modulith) treats each top-level package under the application package as a module, hides its sub-packages, and gives you a one-line test that fails the build when someone reaches into another module's internals:

```java
class ModularityTests {
    @Test
    void modulesRespectTheirBoundaries() {
        ApplicationModules.of(ShopApplication.class).verify();
    }
}
```

Rails teams get the same result with Packwerk, and .NET teams with architecture tests such as NetArchTest. The tool doesn't matter. What matters is that crossing a boundary turns the build red instead of turning up in a code review six months later.

Stage 2 lasted about eighteen months, and it was the most productive period Kestrel had. Then three things happened that modules couldn't fix:

1. **Search had a completely different load profile.** At 21:00 on a sale day, search traffic went up 12x while checkout went up 3x. Scaling the whole app to 40 replicas for search meant 40 copies of everything, each holding database connections that PostgreSQL then ran out of.
2. **PCI DSS scope covered the whole app.** Because card-handling code ran in the same process as everything else, every deploy was technically in scope for the payment card audit. Auditors wanted change evidence for a CSS fix to the product page.
3. **The release train became the bottleneck.** With 30 engineers merging into one deployable, the deploy queue regularly reached two hours. One flaky test in reviews blocked a payments hotfix.

### Stage 3: fifty engineers, a core plus extracted services

Notice what Kestrel did *not* do at this point: rewrite everything as 40 services. They extracted three, each for a reason from the list above:

- **Search**, because it scales differently. It now runs on OpenSearch with its own stateless API, scales on its own HPA, and builds its index from `ProductUpdated` events. If it falls over, the product pages still load and the search box shows "Try again".
- **Payments**, because of compliance. The PCI cardholder data environment shrank from the whole platform to one service, one database and one pipeline. The card details themselves never touch Kestrel's servers anyway (the payment provider's hosted fields handle that), but authorisation, capture, refunds and the provider webhooks do.
- **Inventory**, because a separate team (Fulfil) needed to ship warehouse integrations daily, and the warehouse system pushes stock updates at a rate that has nothing to do with web traffic.

Catalog, cart, checkout, orders, pricing and customers stayed together in a modular core. They change together often, they need strong consistency at checkout, and they had no scaling or compliance reason to leave.

That's the honest answer to "monolith or microservices": usually **both**. A well-modularised core with a handful of services around it, each one extracted because it had to be.

## When to split, and when not to

Here are the signals that reliably justify extracting a service. You want at least one, and preferably two.

| Signal | Example | Why a service helps |
|---|---|---|
| Very different scaling | Search at 12x on sale nights, checkout at 3x | Scale and pay for one part, not the whole app |
| Different compliance or security scope | PCI for payments, PII for customer data | Shrinks the audited surface and the blast radius |
| Different change rate and owner | Warehouse integrations shipped daily by another team | Independent deploys without the release train |
| Different technology need | Search engine, ML ranking in Python, GPU inference | Run each on the runtime that suits it |
| Different availability target | Checkout must stay up when recommendations fail | Failure isolation with its own resources |

And these are the signals that sound convincing but don't justify a split on their own:

- **"The code is messy."** Moving messy code behind HTTP gives you messy code with latency. Fix the module boundaries first.
- **"We want to use microservices."** A CV goal, not an architecture goal.
- **"Netflix does it."** Netflix has thousands of engineers and a platform team bigger than your company.
- **"Each team should own a service."** Teams can own modules. Ownership is about who reviews and who gets paged, not about process boundaries.
- **"We'll need it at scale."** Maybe. Modular code splits easily when you get there. Premature services are very hard to merge back.

A rule of thumb that holds up well: if you can't name the team that will run the new service on-call, you aren't ready to extract it.

## Finding the service boundaries

Getting the boundaries right matters more than the choice of shape. The technique that works best is the one from domain-driven design: find the **bounded contexts**, the areas of the business where a word means one specific thing and one team owns the rules.

<figure class="diagram wide"><a href="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-bounded-contexts.svg" title="Open the full-size diagram"><img src="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-bounded-contexts.svg" alt="Bounded context map for an online shop, each context a dashed box named after its owning team. Discover team owns Catalog (product title, images, attributes) and Search (index rebuilt from events); Catalog publishes ProductUpdated to Search. Promo team owns Pricing (price lists, currency) and Promotions (coupons, rules, budgets). Accounts team owns Identity (login, tokens, MFA) and Customer (addresses, preferences). Buy team owns Cart (lines expiring in 30 days), Orders (order lines with a price snapshot) and Checkout, which orchestrates the saga. Pay team owns Payments in PCI scope. Fulfil team owns Inventory (SKU stock and reservations) and Shipping. Solid synchronous arrows go from Checkout to Cart (read cart), Pricing (quote price), Payments (authorise), Orders, and Inventory (reserve stock with a 15 minute TTL). Dashed event arrows: PaymentCaptured from Payments to Orders, and OrderPlaced from Orders to Shipping, Customer for emails, and Analytics. Two notes: Product is not one thing, since catalog product, inventory SKU and order line are three models with three owners; and a boundary test asking whether a team can change its tables and deploy without asking anyone, and whether one user action needs more than one or two synchronous hops." width="1500" height="860" loading="lazy"></a><figcaption>Bounded contexts for a shop. Each one owns its data. Solid arrows are synchronous calls on the checkout path, dashed arrows are events.</figcaption></figure>

### "Product" is three different things

The clearest example in e-commerce is the word *product*.

- To **Catalog**, a product is a title, a description, images, attributes and categories. It changes when merchandisers edit it.
- To **Inventory**, the thing that matters is the SKU: how many units of "oak dining chair, natural, set of 2" are in which warehouse, and how many are reserved.
- To **Orders**, a product is an order line: what the customer saw and paid for at 20:14 on Friday, including the price and discount. It must never change after checkout, even if catalog renames the product and pricing changes the price.

If all three share one `products` table, every change becomes a negotiation between three teams. Price changes rewrite history on old orders. A stock update locks rows that catalog is editing. That shared table is the single most common reason a microservices split fails: the services look separate, but the data isn't.

Give each context its own model and its own tables. Catalog publishes `ProductUpdated`. Inventory keeps only the SKU and stock fields it needs. Orders stores a snapshot of the line at purchase time. Some data is duplicated on purpose, and that's fine.

### Heuristics that work

- **One team, one context.** If a context needs two teams, it's probably two contexts. If a team owns six, they'll all be neglected.
- **Short synchronous chains.** A user action should need at most one or two synchronous hops. Checkout calling pricing, inventory and payments is acceptable because each is a real decision checkout must wait for. Product page → catalog → pricing → promotions → customer → loyalty is not.
- **Things that change together live together.** Look at your git history. If every change to cart also touches checkout, splitting them will turn every feature into two coordinated deploys.
- **The boundary test.** Can this team change its tables and deploy without asking anyone? If not, the line is in the wrong place.

### Checkout without a distributed transaction

Once orders, inventory and payments are separate, you can't wrap checkout in one database transaction any more. Checkout becomes a **saga**: a sequence of local steps, each with a compensating action if a later step fails.

1. Read the cart and **quote the price** from pricing (with promotions applied). Store the quote ID and its expiry.
2. **Reserve stock** in inventory with a 15 minute TTL. If the reservation fails, stop: nothing to undo.
3. **Authorise the payment** with the payment provider. If it fails, release the stock reservation.
4. **Create the order** in the orders module with the price snapshot and status `PLACED`, and write an `OrderPlaced` event to the outbox *in the same transaction*.
5. Asynchronously: capture the payment, confirm the stock reservation, send the email and create the shipment. If capture fails, the order moves to `PAYMENT_FAILED`, stock is released and the customer gets an email.

Step 4 uses the **transactional outbox** pattern, which you want in a modular monolith too. The order row and the event row commit together, and a separate relay publishes the event later. You never get an order without its event, or an event for an order that rolled back.

```sql
CREATE TABLE orders.outbox (
  id            uuid PRIMARY KEY,
  aggregate_id  uuid        NOT NULL,          -- the order id
  event_type    text        NOT NULL,          -- 'OrderPlaced'
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz                    -- set by the relay
);

BEGIN;
  INSERT INTO orders.orders (id, customer_id, status, total_minor, currency) VALUES ($1, $2, 'PLACED', $3, $4);
  INSERT INTO orders.order_lines (order_id, sku, qty, unit_price_minor, title_snapshot) VALUES ...;
  INSERT INTO orders.outbox (id, aggregate_id, event_type, payload) VALUES (gen_random_uuid(), $1, 'OrderPlaced', $5);
COMMIT;
```

The relay is either a small worker that polls unpublished rows, or change data capture (Debezium reading the PostgreSQL WAL). Consumers must be idempotent, because "at least once" really does mean sometimes twice: store the event ID you processed and skip duplicates.

## API gateway and Backend-for-Frontend

Once there's more than one thing behind the front door, two questions come up quickly: where does authentication happen, and who stitches together the data for a product page? The answer is two different layers with two different jobs.

<figure class="diagram wide"><a href="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-api-gateway-bff.svg" title="Open the full-size diagram"><img src="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-api-gateway-bff.svg" alt="Request path from four clients: web storefront (Next.js with server-side rendering), iOS and Android app (three versions in the wild), marketplace partners (server to server) and back-office (staff with SSO, internal only). Public clients go through a CDN plus WAF for caching, bot rules and TLS, then to an API gateway that does JWT or API-key auth, rate limits per client, routing by path and version, request IDs and access logs, and no aggregation. The gateway routes to four BFFs: Web BFF owned by the web team, Mobile BFF owned by the app team that keeps old app versions working, Partner API that is public and versioned with quotas and webhooks, and Admin BFF with role checks and audit. The Mobile BFF fans out to Catalog, Pricing, Inventory, Reviews and Recommendations in the domain services or modular core, which also contains Cart/Checkout and Orders. A note explains the product page in the app: one call to the Mobile BFF, which calls five services in parallel within a 300 ms budget; catalog, price and stock are required, reviews and recommendations are optional and dropped if they miss the budget. An anti-patterns note warns against business rules in the gateway, one shared BFF for every client, and BFFs calling each other." width="1500" height="790" loading="lazy"></a><figcaption>The gateway owns cross-cutting concerns. Each BFF belongs to the team that owns the screen.</figcaption></figure>

### What the gateway does

The API gateway (a managed one such as Amazon API Gateway, Azure API Management or Apigee, or Envoy, Kong or a Kubernetes Gateway API implementation) handles things every request needs and no team wants to build twice:

- Authentication: validate the JWT or API key, reject anonymous calls to private routes.
- Rate limiting and quotas per client, per partner, per IP.
- Routing by host, path and version, including weighted routing during a migration.
- Request IDs, access logs and the first span of the trace.
- Request size limits, CORS, and TLS to the backends.

What it must **not** do is hold business rules. The moment someone writes "if the cart total is over £500 add free delivery" in a gateway plugin, you have business logic that no domain team owns, can't be unit tested with the rest of the pricing code, and runs in the one component every request depends on.

### What a BFF does

A Backend-for-Frontend is a thin API built for one client, owned by the team that builds that client. Kestrel ended up with four:

- **Web BFF.** Owned by the web team. Shapes data for server-rendered pages and handles session cookies.
- **Mobile BFF.** Owned by the app team. The app has three versions in the wild at any moment, because people don't update. The BFF keeps old response shapes working, so the backend services don't have to.
- **Partner API.** Public, versioned (`/v1`, `/v2`), documented, with quotas and webhooks. Its contract changes slowly on purpose.
- **Admin BFF.** For staff tools, with role checks and an audit trail on every write.

The product page in the app is a good example of why BFFs exist. Without one, the app makes five calls over a mobile network to load one screen. With one, it makes a single call, and the BFF fans out to five services inside the data centre, in parallel, with a time budget:

```ts
// Mobile BFF: GET /app/v3/products/:id
export async function productPage(id: string) {
  const budget = AbortSignal.timeout(300); // whole page: 300 ms
  const get = (url: string) => fetch(url, { signal: budget }).then(r => {
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  });

  const [product, price, stock, reviews, recos] = await Promise.allSettled([
    get(`${CATALOG}/products/${id}`),
    get(`${PRICING}/quotes?sku=${id}`),
    get(`${INVENTORY}/availability/${id}`),
    get(`${REVIEWS}/summary/${id}`),
    get(`${RECOS}/similar/${id}?limit=8`),
  ]);

  // Required parts: no product page without them.
  if ([product, price, stock].some(p => p.status === 'rejected')) {
    throw new ServiceUnavailable('product page dependencies failed');
  }
  // Optional parts: degrade quietly.
  return {
    ...value(product), price: value(price), stock: value(stock),
    reviews: reviews.status === 'fulfilled' ? reviews.value : null,
    similar: recos.status === 'fulfilled' ? recos.value : [],
  };
}
```

The important line is the split between required and optional. If recommendations are slow, the page loads without them. That decision belongs to the team that owns the screen, which is exactly why the BFF belongs to that team too.

Two BFF anti-patterns to watch for. First, **one shared BFF for every client**. It grows into a second monolith that every team edits and nobody owns. Second, **BFFs calling each other**. If the web BFF needs something the mobile BFF has, that logic belongs in a domain service.

## Scenario: the night checkout took the whole shop down

This is the incident that taught Kestrel more about microservices than any design review. It happened early in stage 3, on the evening of their biggest sale.

<figure class="diagram wide"><a href="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-checkout-cascade.svg" title="Open the full-size diagram"><img src="/assets/diagrams/microservices-vs-modular-monolith/ecommerce-checkout-cascade.svg" alt="Two panels. Before: shoppers at 9,000 checkouts per minute go to an API gateway with one shared upstream pool, then Checkout with 200 worker threads, then Payments with a 30 second library default timeout, then a fraud scoring vendor API whose p99 went from 0.4 seconds to 28 seconds. Gateway, Checkout and Payments each retry three times. Product pages, search and cart share the gateway pool. Timeline: 20:02 fraud vendor slows and payments threads wait on 30 second calls; 20:04 checkout's 200 threads are all blocked; 20:05 retries multiply to 27 requests per click; 20:07 the gateway pool fills and product pages and search fail too; 20:31 rollback does nothing, fraud check disabled by hand after 29 minutes of lost sales. Root cause: unbounded waiting, multiplied retries and no isolation. After: the gateway has per-route pools and load shedding; Checkout has a 2 second end-to-end deadline and a bulkhead pool per dependency; Payments authorises with an 800 ms timeout through a circuit breaker that opens at 20 percent errors or slow calls; Fraud scoring has a 300 ms timeout; when the breaker is open a fallback uses a rules-based score and holds orders over 300 dollars for review. Checkout writes to an order-placed queue through the outbox, and workers handle capture, emails and fulfilment with backoff and idempotency keys. Result in the next sale: the fraud vendor slowed for 11 minutes, the breaker opened, zero checkout errors, 214 orders held for review." width="1500" height="900" loading="lazy"></a><figcaption>Nothing crashed. Everything waited. The fixed design turns a slow dependency into a degraded feature instead of an outage.</figcaption></figure>

### What happened

At 20:00 the sale opened and checkout traffic climbed to about 9,000 a minute. The chain for each checkout was gateway → checkout → payments → a third-party fraud-scoring API.

- **20:02.** The fraud vendor started struggling under everyone's sale traffic. Its p99 latency went from 0.4 seconds to 28 seconds. It didn't return errors. It was just slow.
- **20:04.** The payments service used its HTTP library's default timeout: 30 seconds. So every payments thread sat waiting. Checkout, in turn, waited on payments. Checkout's 200 worker threads were all blocked within two minutes.
- **20:05.** The gateway, checkout and payments each had "retry 3 times on timeout" configured, independently. One customer click could now produce 3 × 3 × 3 = 27 calls to the fraud vendor, which made the vendor slower still.
- **20:07.** The gateway used one connection pool for all upstream routes. It filled up with stuck checkout requests, and product pages, search and cart started returning 503s. The whole shop was now down, not just checkout.
- **20:15.** The on-call engineer rolled back the day's deploy. Nothing improved, because nothing in the code had changed.
- **20:31.** Someone found the fraud vendor's status page, and the fraud check was disabled by a manual config change. Twenty-nine minutes of the year's busiest evening were gone.

Nothing crashed. There were no exceptions in the logs worth reading. Every service was "healthy" by its liveness probe. (If that sounds familiar, the difference between [readiness and liveness probes](/blog/kubernetes-readiness-vs-liveness/) matters a lot here: a pod that is alive but can't serve should stop receiving traffic.)

The root cause was not the vendor. Vendors get slow. The root cause was **unbounded waiting, multiplied retries and no isolation**. A modular monolith calling the same fraud vendor with the same 30 second timeout would have gone down the same way. Microservices just add more places to get it wrong.

### What changed

**1. Deadlines instead of timeouts.** Each checkout gets a 2 second end-to-end budget at the edge. Every downstream call carries the remaining budget (in gRPC that's the built-in deadline; over HTTP, a header such as `x-request-deadline`). Payments gets at most 800 ms, fraud scoring at most 300 ms. Nothing waits longer than the user is willing to.

**2. Retries in one place only.** The client or the gateway retries, with exponential backoff and jitter, and only idempotent requests. Inner services don't retry by default. A retry budget caps retries at around 10% of requests, so retries can't multiply load during an incident.

**3. Circuit breaker with a business fallback.** The fraud call goes through a breaker. When 20% of calls fail or are slow, it opens and stops calling the vendor for 30 seconds. The fallback is a decision the business signed off in advance: score with simple in-house rules, accept orders under $300, and hold bigger ones for manual review. With resilience4j in a Spring service, the configuration is a few lines:

```yaml
resilience4j:
  circuitbreaker:
    instances:
      fraud:
        slidingWindowType: COUNT_BASED
        slidingWindowSize: 100
        failureRateThreshold: 20
        slowCallRateThreshold: 20
        slowCallDurationThreshold: 250ms
        waitDurationInOpenState: 30s
        permittedNumberOfCallsInHalfOpenState: 10
  timelimiter:
    instances:
      fraud:
        timeoutDuration: 300ms
  bulkhead:
    instances:
      fraud:
        maxConcurrentCalls: 40
        maxWaitDuration: 0
```

**4. Bulkheads.** Separate connection pools and concurrency limits per dependency, in checkout and in the gateway. A slow fraud vendor can now use at most 40 of checkout's concurrent slots, and none of search's. At the gateway, each route has its own upstream pool, plus load shedding that returns a fast 503 with `Retry-After` when a route is saturated, instead of queueing forever.

**5. An async tail.** Checkout now does only what the customer must wait for: price, stock reservation, payment authorisation, and writing the order (with its outbox event). Payment capture, confirmation emails, loyalty points and fulfilment happen from a queue, with retries and idempotency keys. The customer sees "Order received" in under a second, and the rest can take as long as it needs.

At the next sale, the fraud vendor slowed down again for eleven minutes. The breaker opened, 214 orders were held for review, and checkout recorded zero errors. Most customers never knew.

The lesson for the architecture debate: **microservices are a distributed system, and distributed systems fail slowly, not cleanly**. If you aren't ready to put deadlines, breakers and bulkheads on every network call, you aren't ready for microservices. A modular monolith gets to skip most of this, because in-process calls don't time out.

## Migrating: the strangler fig, one route at a time

If you already have a monolith and you've found a real reason to extract a service, don't do a big-bang rewrite. Use the [strangler fig pattern](https://martinfowler.com/bliki/StranglerFigApplication.html): put a routing layer in front, move one capability at a time, and shift traffic gradually.

Kestrel extracted search first, because it was read-only (no writes to move) and had the clearest scaling reason. The steps:

1. **Modularise inside the monolith first.** Search became a module with its own interface. Every caller went through `search.api`. This took three weeks and was most of the real work.
2. **Build the new service** behind the same interface, with its own index built from `ProductUpdated` events (plus a one-off backfill).
3. **Shadow traffic.** The gateway copied 1% of search requests to the new service and compared results offline. That found two ranking differences and a Unicode bug before any customer saw them.
4. **Shift traffic by weight.** 10%, then 50%, then 100%, watching error rate and p95 latency at each step.
5. **Delete the old module.** This is the step everyone forgets. Until the old code is gone, you are maintaining two search engines.

With the Kubernetes Gateway API, the weighted shift is a few lines:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-api
spec:
  parentRefs:
    - name: public-gateway
  hostnames: ["api.kestrel.example"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /api/search }
      backendRefs:
        - name: search-svc     # new service
          port: 8080
          weight: 10
        - name: shop-app       # the monolith
          port: 8080
          weight: 90
    - matches:
        - path: { type: PathPrefix, value: / }
      backendRefs:
        - name: shop-app
          port: 8080
```

A few rules that save migrations:

- **Never dual-write from application code.** Writing to the old and new database in the same request will drift the first time one write fails. Write to one place and replicate with events or CDC.
- **Move the data last, and move it once.** Read paths first (search, catalog views), then write paths with clear ownership (inventory), and the tangled core (checkout, orders) last or never.
- **Keep the old path one config change away** until the new service has survived a sale day.

## The bill: what each shape costs to run

Kestrel's rough numbers at 50 engineers, comparing the modular core they kept with a hypothetical "everything is a service" design of about 25 services:

| | Modular core + 3 services | ~25 microservices |
|---|---|---|
| Deploy pipelines | 4 | 25 |
| On-call rotas | 3 | 7 (one per team), each covering 3 to 5 services |
| Databases to patch, back up and tune | 4 | 15+ |
| Network hops for one checkout | 3 | 8 to 12 |
| Platform work needed | Gateway, tracing, event bus | Plus service mesh or mTLS, service catalogue, contract testing, per-service SLOs |
| Time to add a field to the order page | One PR, one deploy | Often 2 to 4 PRs across teams, deployed in order |

None of this means microservices are wrong. It means each service has a running cost in people's attention, and it should buy you something specific: independent scaling, a smaller audit scope, a team that's no longer blocked.

## Mistakes that keep coming up

1. **Splitting by entity instead of capability.** A "user service" and a "product service" get called by everything, and every feature needs changes in both.
2. **Sharing a database between services.** The fastest route to a distributed monolith. If two services write the same table, merge them or give one of them ownership and an API.
3. **Synchronous chains of four or more hops.** Each hop multiplies latency and failure. Use events for anything that doesn't need an answer before the page renders.
4. **Retries at every layer.** They multiply. Pick one layer and give it a budget.
5. **Library-default timeouts.** Many HTTP clients default to 30 seconds, or to no timeout at all. Set every one explicitly, below the caller's own deadline.
6. **No idempotency.** Payment capture, order creation and stock reservation must accept a request ID and return the same result for the same ID. Retries and at-least-once events will send duplicates.
7. **Extracting before modularising.** If you can't draw the module boundary in the monolith, you can't draw the service boundary either.
8. **A shared "common" library that everyone must upgrade together.** Shared code for logging and auth helpers is fine. Shared domain models are a monolith in disguise.
9. **Forgetting the platform cost.** Microservices need tracing, centralised logs, service discovery, secret management and per-service CI/CD before they need anything else. Budget a platform team, or don't split yet.

## A decision checklist

Before you extract a service from an e-commerce platform, you should be able to answer yes to most of these:

- [ ] We can name the reason: scaling, compliance, technology or team independence.
- [ ] The capability already exists as a clean module with its own interface and schema.
- [ ] One team will own it, deploy it and carry its pager.
- [ ] It owns its data, and no other service will write to its tables.
- [ ] Callers can live with it being slow or unavailable (fallback, cache, or async).
- [ ] Every call to it has a timeout below the caller's deadline, and retries happen in one place.
- [ ] Events it publishes go through an outbox, and its consumers are idempotent.
- [ ] We have tracing across services, so an incident won't start with "which service is slow?"
- [ ] We have a rollback path: the old route is one config change away.

If you can't tick most of these, keep it as a module for now. A good modular monolith is not a stepping stone you're embarrassed about. For a lot of shops, it's the destination.

## Download the diagrams

All five diagrams are editable draw.io files. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the module names, teams and numbers to match your own platform.

- [All five diagrams in one file (5 pages)](/assets/diagrams/microservices-vs-modular-monolith/microservices-vs-modular-monolith.drawio)
- [Same shop, two shapes: modular monolith vs microservices](/assets/diagrams/microservices-vs-modular-monolith/ecommerce-monolith-vs-microservices.drawio)
- [Scenario: growing from 5 to 50 engineers](/assets/diagrams/microservices-vs-modular-monolith/ecommerce-team-growth-5-to-50.drawio)
- [Bounded contexts and data ownership](/assets/diagrams/microservices-vs-modular-monolith/ecommerce-bounded-contexts.drawio)
- [API gateway and Backend-for-Frontend](/assets/diagrams/microservices-vs-modular-monolith/ecommerce-api-gateway-bff.drawio)
- [Checkout outage cascade, before and after](/assets/diagrams/microservices-vs-modular-monolith/ecommerce-checkout-cascade.drawio)

Kestrel Home is fictional, and the numbers are illustrative, but every failure in it is one I've seen in real shops.

## References

- [Martin Fowler: MonolithFirst](https://martinfowler.com/bliki/MonolithFirst.html)
- [Martin Fowler: Strangler Fig Application](https://martinfowler.com/bliki/StranglerFigApplication.html)
- [Sam Newman: Backends For Frontends](https://samnewman.io/patterns/architectural/bff/)
- [Shopify Engineering: Deconstructing the Monolith](https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity)
- [Spring Modulith](https://spring.io/projects/spring-modulith)
- [import-linter documentation](https://import-linter.readthedocs.io/)
- [microservices.io: Saga pattern](https://microservices.io/patterns/data/saga.html)
- [microservices.io: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- [Azure Architecture Center: Backends for Frontends pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends)
- [Azure Architecture Center: Circuit Breaker pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker)
- [AWS Prescriptive Guidance: Strangler fig pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/strangler-fig.html)
- [Google SRE book: Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)
- [Resilience4j: CircuitBreaker](https://resilience4j.readme.io/docs/circuitbreaker)
- [Kubernetes Gateway API: HTTPRoute](https://gateway-api.sigs.k8s.io/api-types/httproute/)
