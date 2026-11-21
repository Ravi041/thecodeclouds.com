---
title: "Event-driven order processing on AWS with EventBridge, SQS and Step Functions"
description: "A production design for order processing on AWS: a DynamoDB outbox, EventBridge Pipes and an event bus, SQS queues with dead-letter queues, a Step Functions saga with compensations, idempotency at every hop, ordering per order, and backpressure for a Black Friday peak. Requirements, real numbers, a Well-Architected review and four editable draw.io diagrams."
date: 2026-11-21T03:03:00Z
category: Cloud & DevOps
coverLabel: "Every order.\nExactly once.\nEven on Black Friday."
coverCode: "EventBridge → SQS → Step Functions"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-event-driven-order-processing-eventbridge-sqs.jpg
coverImageAlt: "Cloud & DevOps cover reading 'Every order. Exactly once. Even on Black Friday.', with the AWS logo."
---
An order is the one thing an online shop cannot afford to lose, and also the thing it is most tempted to process in a hurry. The checkout handler grows: it saves the order, reserves stock, calls the fraud service, sends the confirmation email, pushes the order to the warehouse and updates the ERP, all inside one HTTP request. It works on a normal Tuesday. Then the warehouse API slows down on Black Friday, checkout requests start timing out, customers press "Pay" again, and you spend the weekend refunding double charges.

Event-driven order processing fixes that by splitting the job in two. Checkout does one thing: it records the order durably and says "thank you". Everything after that happens as events, at the speed each downstream system can handle, with retries, dead-letter queues and a workflow that knows how to undo its own steps.

This article is the design I would use on AWS today. It covers the requirements, the architecture, the choices behind each service, the failure paths, idempotency, ordering, backpressure and cost, and then walks through six real scenarios with numbers. Each decision is mapped to the AWS Well-Architected Framework, and all four diagrams are editable draw.io files built with the official AWS shapes. You can download them at the end.

## The short version

- **Checkout writes one DynamoDB item and returns.** The table's stream is the outbox, so there is no "saved the order but failed to publish the event" bug.
- **EventBridge Pipes moves stream records onto an EventBridge bus.** Rules fan events out to SQS queues, never straight to code that might be down.
- **A Step Functions Standard workflow runs the order saga**, one execution per order, named after the order ID so a duplicate event can't start a second one.
- **Every hop has a retry policy and a place to park failures**, and every dead-letter queue has an alarm.
- **Idempotency at four levels**: the API, the saga start, every consumer and every call to a payment or warehouse API.
- **Order only where you need it**: tolerant consumers on the bus, and SQS FIFO fed from the stream for the one system that needs strict order.
- **Backpressure through queues and Lambda maximum concurrency**, so a slow warehouse makes a queue longer instead of making checkout fail.

## The scenario and the requirements

The design is built for a mid-size online retailer. The numbers are realistic for a shop doing a few hundred million in annual sales.

- **2 million orders a month.** Normal peak is around 30 orders per second in the evening.
- **Black Friday:** 400 orders per second for the first 10 minutes of the sale, then back to about 30.
- **Payment** is authorised at checkout by a payment service provider and captured when the parcel ships. The card details never touch our systems; we hold a payment reference.
- **The warehouse management system (WMS)** is a third-party API with a contractual limit of **100 requests per second**. It confirms "picked and packed" by calling a webhook, minutes or hours later.
- **The ERP** on premises needs every order status change, in the right order per order, for finance.
- **Analytics** wants every order event in the data lake.

### Functional requirements

1. Accept an order and return an order ID within **300 ms at p99**.
2. Reserve stock, score the order for fraud, release it to the warehouse, capture payment on shipment.
3. Email the customer when the order is placed and when it ships.
4. Cancel cleanly if stock runs out, fraud scores high, or the warehouse rejects the order: release stock, void the payment authorisation, tell the customer.
5. Send every status change to the ERP, in order, per order.
6. Land every event in S3 for analytics within 5 minutes.

### Non-functional requirements

| Requirement | Target |
| --- | --- |
| Durability | Zero accepted orders lost once the API has returned 202 |
| Correctness | No double charge, no double shipment, no duplicate customer email |
| Availability of order intake | 99.95% a month, unaffected by warehouse, ERP or email outages |
| Latency to warehouse | p95 under 60 seconds normally, under 60 minutes during sale peaks |
| Resilience | Survive a 4-hour warehouse outage without losing or cancelling orders |
| Recovery | Replay any event from the last 30 days |
| Cost | Under a tenth of a cent per order for the pipeline itself |
| Security | No card data in events; encryption at rest with KMS; least-privilege IAM per function |

Write these down before you draw anything. Most of the design choices below fall straight out of this table, and the table is what you'll defend in a design review.

## The architecture

<figure class="diagram wide"><a href="/assets/diagrams/aws-event-driven-orders/order-events-hld.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-event-driven-orders/order-events-hld.svg" alt="High-level architecture inside one AWS Region with three Availability Zones. Shoppers call API Gateway with AWS WAF on POST /orders, which invokes the Order API Lambda with an Idempotency-Key. The Lambda writes the order to a DynamoDB orders table whose stream acts as the outbox. EventBridge Pipes filters status changes from the stream and puts them on an EventBridge orders bus with a 30-day archive. Rules on the bus fan out to an SQS notify queue with a dead-letter queue, read by a Notifier Lambda that sends confirmation email through Amazon SES; to Amazon Data Firehose, which writes all order events to an S3 data lake queried by Athena; and on OrderPlaced to an SQS saga-start queue, read by a saga starter Lambda that starts a Step Functions Standard order saga named after the order ID. The saga sends a message with a task token to the wms-requests SQS queue, read by a WMS worker Lambda with maximum concurrency 20 that calls the warehouse system, which has a 100 requests per second limit and calls back with SendTaskSuccess through a webhook. The saga writes each step to the order item so the stream emits StockReserved and OrderShipped. A second pipe reads the same DynamoDB stream into an SQS FIFO queue, erp-sync.fifo, with the message group set to the order ID, read by an ERP sync Lambda that updates the on-premises ERP in order. An operations panel shows dead-letter queues per hop, CloudWatch alarms on age of oldest message and DLQ depth, and X-Ray traces with the order ID on every event." width="1500" height="990" loading="lazy"></a><figcaption>Checkout writes one item. Everything after that is events, buffered by queues and coordinated by one workflow per order.</figcaption></figure>

Follow an order through it:

1. **Checkout calls `POST /orders`** on API Gateway with an `Idempotency-Key` header (a UUID the client generates once per checkout attempt). AWS WAF sits in front for rate limiting and bot rules.
2. **The Order API Lambda writes one item** to the DynamoDB `orders` table with a conditional put, and returns `202 Accepted` with the order ID. That is the whole synchronous path: one Lambda, one write.
3. **DynamoDB Streams captures the change** and an **EventBridge Pipe** turns it into an `OrderPlaced` event on a custom `orders` bus. The bus keeps a 30-day archive.
4. **Rules on the bus fan out to SQS queues**, one per consumer: notifications, the saga starter, and a Data Firehose stream to S3 for analytics.
5. **The saga starter** starts a **Step Functions Standard** execution named after the order ID. The saga reserves stock, scores fraud, releases the order to the warehouse, waits for the pick confirmation, captures the payment and marks the order shipped. Each step updates the order item, so the stream emits `StockReserved`, `OrderShipped` and the rest.
6. **The warehouse call goes through a queue** with a Lambda capped at 20 concurrent executions, which keeps us under the WMS limit of 100 requests per second.
7. **A second pipe** reads the same stream into an **SQS FIFO** queue with `MessageGroupId = orderId`, so the ERP gets each order's changes in order.

Everything is regional and spread over three Availability Zones by the services themselves. No servers, no clusters, nothing to patch.

## Why these services

### The outbox: DynamoDB Streams instead of "write, then publish"

The classic bug in event-driven systems is the dual write. The handler saves the order to the database and then publishes an event. If the process dies between the two, you have an order nobody else knows about. If you publish first and the write fails, you have an event about an order that doesn't exist.

The fix is the outbox pattern: write the state change and the "event to publish" in the same transaction, and have something else relay it. With DynamoDB you get this almost for free. The stream records every change to an item, in order per item, and keeps it for 24 hours. The Order API only writes the order. EventBridge Pipes reads the stream and publishes. If Pipes is briefly unavailable, the records wait in the stream.

Each order item carries a `version` number and a `lastEvent` attribute. Every write increments the version and sets the event name, and the pipe filter only forwards records where `lastEvent` is present:

```json
{
  "eventName": ["INSERT", "MODIFY"],
  "dynamodb": {
    "NewImage": { "lastEvent": { "S": [{ "exists": true }] } }
  }
}
```

An input transformer on the pipe shapes the record into a clean event. This is the contract everything downstream depends on, so keep it small and versioned:

```json
{
  "source": "shop.orders",
  "detail-type": "OrderPlaced",
  "detail": {
    "orderId": "ord_7Q2K9X",
    "version": 1,
    "occurredAt": "2026-11-27T08:00:03.120Z",
    "customerId": "cus_44118",
    "total": { "amount": 6800, "currency": "GBP" },
    "lines": [{ "sku": "TRN-42-BLK", "qty": 1 }],
    "paymentRef": "pay_3N8f2kQ"
  }
}
```

Note what isn't there: no card number, no full address. Consumers that need more fetch it by `orderId` with their own IAM permission. That keeps the bus out of PCI DSS scope and keeps personal data in one place.

### EventBridge for routing, SQS for buffering

EventBridge and SQS are not alternatives here; they do different jobs.

**EventBridge** is the router. Producers don't know who is listening. Adding a new consumer (say, a loyalty points service next quarter) is a new rule, not a change to checkout. Content-based filtering means each consumer subscribes to exactly the events it needs. The archive lets you replay history. The schema registry documents the events for other teams.

**SQS** is the buffer. Every rule target in this design is a queue, not a Lambda function directly. That gives each consumer its own retry behaviour, its own dead-letter queue, its own scaling limit, and a backlog you can see and alarm on. If the notifier is broken for an hour, its queue fills up and nothing else notices.

EventBridge delivers to targets at least once, and does not guarantee order. Both facts shape the rest of the design: every consumer has to be idempotent, and anything that needs order gets it from somewhere else.

### Step Functions Standard for the saga

Processing an order is a sequence of steps across systems that don't share a transaction: inventory, fraud, the warehouse, the payment provider. When step four fails, steps one to three need undoing. That is a saga, and it needs something to remember where each order is.

You can build a saga as choreography (each service reacts to the previous one's event) or orchestration (one coordinator tells each service what to do). I use orchestration for the money path. Choreography is fine for fan-out side effects like email and analytics, but for "reserve, check, ship, capture, or undo all of it", one workflow you can open in the console and read is worth a lot when a customer calls.

Step Functions has two workflow types, and the choice matters:

| | Standard | Express |
| --- | --- | --- |
| Maximum duration | 1 year | 5 minutes |
| Execution semantics | Exactly-once | At-least-once (async), at-most-once (sync) |
| `StartExecution` with the same name | Idempotent while running; name reusable 90 days after close | Not idempotent; names reusable immediately |
| Priced by | State transitions | Executions, duration and memory |

The order saga waits for the warehouse to pick and pack, which can take hours, so it must be **Standard**. Standard also gives us idempotent starts: the saga starter names the execution after the order ID, and a duplicate `OrderPlaced` event can't create a second saga.

## The saga in detail

<figure class="diagram wide"><a href="/assets/diagrams/aws-event-driven-orders/order-saga.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-event-driven-orders/order-saga.svg" alt="The order saga as a Step Functions Standard workflow, one execution per order named after the order ID. Happy path in green: OrderPlaced, then ReserveStock as a DynamoDB transaction if available stock is at least the quantity, with retries on throttling; then ScoreFraud in Lambda with three retries; then a choice on score below 0.8; then ReleaseToWarehouse, an SQS send with waitForTaskToken and a 48-hour timeout, waiting for the warehouse to pick and pack. A blue dashed line marks the pivot where goods leave the building. After the pivot, CapturePayment as an HTTP Task to the provider API with an idempotency key and six retries over about an hour, then MarkShipped as a DynamoDB update that increments the version so the stream emits OrderShipped, then Shipped succeeded. Compensation in red, undoing in reverse order: an OutOfStock catch on ReserveStock goes straight to VoidAuthorization because nothing was reserved; a high fraud score, a fraud error, or a warehouse rejection or timeout goes to ReleaseStock, which deletes the reservation, then VoidAuthorization, then MarkCancelled, which makes the stream emit OrderCancelled, then Cancelled with the customer emailed. Forward recovery in blue: if CapturePayment still fails after retries, the order is parked on an SQS ops queue with an alarm for a person to retry the capture, because the parcel is already shipped and refunding automatically would give the goods away." width="1500" height="820" loading="lazy"></a><figcaption>Compensate before the pivot, recover forward after it. Once the parcel is on a truck, undoing the payment is the wrong move.</figcaption></figure>

The important idea is the **pivot**. Before the warehouse ships, every step can be undone: release the stock, void the authorisation, cancel the order. After the parcel leaves, compensation stops making sense. If the capture fails, you don't refund and hope; you retry for an hour, then park the order for a person. Every saga has a pivot. Find yours and draw it on the diagram.

### Waiting for the warehouse with a task token

The warehouse step uses the `.waitForTaskToken` integration. Step Functions sends a message to the `wms-requests` queue containing a task token, then pauses the execution (at no cost while it waits). The WMS worker calls the warehouse with the token in the request. When the warehouse confirms the pick, its webhook calls `SendTaskSuccess` with the token, and the saga continues.

```json
"ReleaseToWarehouse": {
  "Type": "Task",
  "Resource": "arn:aws:states:::sqs:sendMessage.waitForTaskToken",
  "Parameters": {
    "QueueUrl": "${WmsRequestsQueueUrl}",
    "MessageBody": {
      "orderId.$": "$.orderId",
      "taskToken.$": "$$.Task.Token"
    }
  },
  "TimeoutSeconds": 172800,
  "Retry": [
    {
      "ErrorEquals": ["Warehouse.Busy"],
      "IntervalSeconds": 60,
      "BackoffRate": 2,
      "MaxAttempts": 5,
      "JitterStrategy": "FULL"
    }
  ],
  "Catch": [
    {
      "ErrorEquals": ["Warehouse.Rejected", "States.Timeout"],
      "ResultPath": "$.error",
      "Next": "ReleaseStock"
    }
  ],
  "Next": "CapturePayment"
}
```

`Warehouse.Busy` and `Warehouse.Rejected` are our own error names, sent by the worker or the webhook with `SendTaskFailure`. Business errors go to compensation; transient ones are retried with jitter so 50,000 paused orders don't all retry in the same second.

### Starting the saga exactly once

The saga starter is a small Lambda behind the `saga-start` queue. It exists for two reasons: the queue gives us a buffer and a DLQ in front of Step Functions, and the function controls the execution name.

```python
import json, os, boto3

sfn = boto3.client("stepfunctions")

def handler(event, context):
    failures = []
    for record in event["Records"]:
        detail = json.loads(record["body"])["detail"]
        try:
            sfn.start_execution(
                stateMachineArn=os.environ["SAGA_ARN"],
                name=detail["orderId"],                    # one saga per order
                input=json.dumps(detail, sort_keys=True),  # deterministic input
            )
        except sfn.exceptions.ExecutionAlreadyExists:
            pass  # duplicate OrderPlaced: the saga already exists
        except Exception:
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}
```

For Standard workflows, calling `StartExecution` again with the same name and the same input while the execution is running returns the original response. If the execution has finished, or the input differs, you get `ExecutionAlreadyExists`, which here means "already started". Build the input only from the event detail, sorted, so a redelivered message produces exactly the same input.

## Idempotency at every hop

At-least-once delivery means every consumer will, eventually, see the same message twice. Idempotency is how you make that harmless. You need it in four places:

1. **The API.** The client sends an `Idempotency-Key`. The Order API stores the key and the response in a DynamoDB table with a 24-hour TTL. A retry with the same key gets the same order ID back, and no second order is written. [Powertools for AWS Lambda](https://docs.powertools.aws.dev/lambda/python/latest/utilities/idempotency/) implements this with one decorator, including the "request still in progress" case.
2. **The saga start.** The execution name, as above.
3. **Every consumer.** The notifier keys on `orderId + detail-type`, so a duplicate `OrderShipped` doesn't send a second email. Projections compare `version` before writing.
4. **Every external call.** The payment provider capture and void use an idempotency key built from `orderId + step`, so a retried capture after a timeout can't capture twice. If a provider doesn't support idempotency keys, look up the state first, then act.

A stock reservation is worth special care because it is the step that oversells. Don't decrement a counter. Write a reservation item per order and decrement the stock in the same DynamoDB transaction, conditional on the reservation not existing and stock being sufficient. Releasing stock deletes the reservation conditionally and adds the quantity back in the same transaction, so a retried release can't add stock twice.

## Failure handling: where every failed event goes

<figure class="diagram wide"><a href="/assets/diagrams/aws-event-driven-orders/order-failures.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-event-driven-orders/order-failures.svg" alt="A table of four hops showing where failures go. Hop 1, outbox to bus: a DynamoDB stream record that the EventBridge pipe cannot deliver is retried with MaximumRetryAttempts 10 and MaximumRecordAgeInSeconds 3600, because records for one item stay in order and a stuck record holds back its shard; it is then parked in a pipe dead-letter queue in SQS, with an alarm on DLQ depth above zero, and recovered by fixing the target and replaying the records with a small script. Hop 2, bus to target: when an EventBridge rule's target refuses or throttles, the retry policy allows up to 185 attempts over 24 hours by default with exponential backoff, and lower MaximumEventAgeInSeconds is recommended for events that are useless when late; failures are parked in a target DLQ in SQS, alarmed on InvocationsSentToDlq and FailedInvocations, and redriven after fixing IAM or quota. Hop 3, queue to worker: when Lambda throws or times out, the message reappears after the visibility timeout, which should be six times the function timeout; ReportBatchItemFailures retries only the failed message; after maxReceiveCount 5 it goes to a DLQ of the same queue type, alarmed on visible messages and age of oldest message, and recovered with a DLQ redrive using StartMessageMoveTask. Hop 4, saga step: a failing Step Functions task calling a payment or warehouse API retries with BackoffRate 2, MaxDelaySeconds and full jitter; Catch routes business errors to compensation and everything else to a parked state; failed executions are alarmed on ExecutionsFailed and ExecutionsTimedOut and restarted with RedriveExecution from the failed state." width="1500" height="860" loading="lazy"></a><figcaption>Each hop retries on its own terms, then parks what it can't process. A DLQ nobody watches is just a slower way to lose orders.</figcaption></figure>

The rule is simple to say and easy to forget: every hop needs a retry policy, a place to park what fails, an alarm on that place, and a documented way to put things back.

- **Pipe from the stream.** A DynamoDB stream keeps records for one item in order, so a record that keeps failing blocks the records behind it on that shard. Set `MaximumRetryAttempts` and `MaximumRecordAgeInSeconds`, and give the pipe a dead-letter queue.
- **EventBridge targets.** The default retry policy keeps trying for 24 hours and up to 185 attempts. Configure an SQS dead-letter queue on every target; without one, events that exhaust their retries are dropped. The DLQ message includes the error code, which is usually a permissions or quota problem.
- **SQS to Lambda.** Turn on `ReportBatchItemFailures` so one bad message doesn't make the whole batch retry. Set the queue's visibility timeout to at least six times the function timeout, as the Lambda docs recommend. Use `maxReceiveCount` of 5 or so, and make the DLQ's retention longer than the source queue's, because for standard queues the expiry is based on when the message was first sent, not when it reached the DLQ.
- **Step Functions.** `Retry` with backoff and jitter on every Task, `Catch` on every Task, and an alarm on `ExecutionsFailed`. When you've fixed the bug, `RedriveExecution` restarts a failed Standard execution from the step that failed, keeping everything before it.

Here is the WMS queue and its event source mapping in CloudFormation:

```yaml
WmsRequestsDLQ:
  Type: AWS::SQS::Queue
  Properties:
    MessageRetentionPeriod: 1209600      # 14 days, the maximum
    SqsManagedSseEnabled: true

WmsRequests:
  Type: AWS::SQS::Queue
  Properties:
    VisibilityTimeout: 180               # 6 x the 30-second function timeout
    MessageRetentionPeriod: 345600       # 4 days
    SqsManagedSseEnabled: true
    RedrivePolicy:
      deadLetterTargetArn: !GetAtt WmsRequestsDLQ.Arn
      maxReceiveCount: 5

WmsWorkerMapping:
  Type: AWS::Lambda::EventSourceMapping
  Properties:
    EventSourceArn: !GetAtt WmsRequests.Arn
    FunctionName: !Ref WmsWorker
    BatchSize: 1
    FunctionResponseTypes: [ReportBatchItemFailures]
    ScalingConfig:
      MaximumConcurrency: 20             # 20 x 200 ms = 100 calls/s
```

Finally, run a **reconciliation job**. Every 15 minutes, a scheduled Lambda queries a GSI on `status` and `updatedAt` for orders that have been in one status longer than its SLO: `PLACED` for more than 5 minutes, `RELEASED` for more than 24 hours. Queues and DLQs catch failures you expected. Reconciliation catches the ones you didn't.

## Ordering and backpressure

<figure class="diagram wide"><a href="/assets/diagrams/aws-event-driven-orders/order-ordering-backpressure.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-event-driven-orders/order-ordering-backpressure.svg" alt="Two panels. Left panel, ordering per order, not global. Part A: the EventBridge bus does not promise order, so events arrive as v3 Shipped, v1 Placed, v2 Paid at a projection Lambda that writes to an orders-view table with a condition that the stored version is missing or lower than the event version, so a late v1 after v3 is dropped on purpose. Part B: a consumer that truly needs order gets it from the DynamoDB stream through a pipe into an SQS FIFO queue, erp-sync.fifo, with three message groups: group A holds A v1, A v2, A v3; group B holds B v1, B v2; group C holds C v1. The ERP sync Lambda processes one batch per group at a time. Notes: order is kept inside each message group and different orders run in parallel; one stuck message blocks only its own order; and putting a FIFO queue after the bus does not restore order, because the bus may already have reordered events. Right panel, backpressure on Black Friday at the warehouse: the saga produces 400 orders per second at peak into the wms-requests SQS queue with 4-day retention, read by the WMS worker Lambda with MaximumConcurrency 20, calling the warehouse API with its 100 requests per second limit. 20 workers times 200 milliseconds per call gives 100 calls per second. A chart of queue depth over 60 minutes rises at 300 messages per second to a peak of 180,000 at 10 minutes, then falls at 70 messages per second, with 30 new orders per second still arriving and 100 going out, and is empty at about 53 minutes. An alarm fires on age of oldest message above 45 minutes during sale events and above 5 minutes on normal days, and the saga's 48-hour task token timeout means a slow warehouse never cancels an order." width="1500" height="880" loading="lazy"></a><figcaption>Ask for order per order, not globally. Let queues hold the spike that the warehouse can't.</figcaption></figure>

### Ordering: be specific about what needs it

"We need events in order" is usually true for much less than people think. Ask per consumer:

- **Email and analytics** don't care. A shipped email arriving a second before the placed email is unlikely and harmless.
- **Projections** (an orders view for customer service, say) care, but can handle it themselves. Each event carries the order's `version`. The projection writes with a condition that the stored version is lower, so a late `v1` that arrives after `v3` is dropped on purpose.
- **The ERP** really does need every change, in order, per order. Finance reconciles on it.

For the ERP, order has to be preserved from the source to the consumer. DynamoDB Streams already keeps changes to one item in order. A second pipe reads the stream into an **SQS FIFO** queue with `MessageGroupId` set to the order ID. Lambda processes each message group in order and different groups in parallel, so throughput grows with the number of active orders, not the number of queues.

One trap: putting a FIFO queue behind the EventBridge bus doesn't give you order. The bus may already have delivered events out of order, and the FIFO queue will faithfully preserve the wrong order.

Throughput is rarely a concern for this path. A FIFO queue in high-throughput mode spreads message groups across partitions, each handling up to 3,000 messages per second with batching, and the ERP is far slower than that anyway.

### Backpressure: let the queue get long

The warehouse takes 100 requests per second and no more. On Black Friday the saga releases 400 orders per second for 10 minutes. Something has to give, and it should be the queue, not the warehouse and not checkout.

The WMS worker's event source mapping has `MaximumConcurrency: 20`. Each warehouse call takes about 200 ms, so 20 concurrent workers make 100 calls per second. The rest wait in SQS.

- **During the peak:** 400 in, 100 out, so the backlog grows by 300 per second. After 10 minutes it holds **180,000 messages**.
- **After the peak:** about 30 orders per second still arrive and 100 go out, so the backlog shrinks by 70 per second. 180,000 / 70 is about 2,570 seconds, or **43 minutes**.
- **Total:** the last Black Friday order of the rush reaches the warehouse about 53 minutes after the sale opens. That is inside the 60-minute peak SLO, and the queue's 4-day retention gives an enormous margin.

Use the event source mapping's `MaximumConcurrency`, not a low reserved concurrency on the function. With reserved concurrency, Lambda's pollers keep pulling messages, the invocations get throttled, the messages go back to the queue, and their receive count climbs until perfectly good orders land in the DLQ. Maximum concurrency stops the pollers from taking more than the function can process.

For very high-volume queues, Lambda's provisioned mode for SQS event source mappings lets you set a minimum and maximum number of pollers for faster scaling, at an extra cost. At 400 messages per second you don't need it; the default mode scales by up to 300 concurrent invocations per minute.

Alarm on `ApproximateAgeOfOldestMessage`, not queue depth. Depth tells you how much work there is; age tells you whether you're breaking a promise to a customer. During sale events the threshold is 45 minutes; on a normal day it is 5.

## Six real scenarios

### 1. Black Friday opens at 08:00

At 08:00:00 traffic jumps from 30 to 400 orders per second. API Gateway and Lambda scale with it, and DynamoDB on-demand absorbs the writes (pre-warm the table if you expect more than double your previous peak). Checkout p99 stays under 300 ms because checkout only does one write. The `wms-requests` queue climbs to 180,000 messages by 08:10 and is empty by about 08:53. The age-of-oldest-message alarm never reaches 45 minutes. Nobody is paged. The customers got their confirmation emails within seconds, because the notify queue has no rate limit.

### 2. The mobile app retries checkout

A shopper on a train presses "Pay". The request reaches the API, the order is written, and the response is lost in a tunnel. The app retries twice in 2 seconds with the same `Idempotency-Key`. The first retry finds the stored response and returns the same order ID. The second does the same. One order, one authorisation, one email. Without the key, that's three orders and a refund ticket.

### 3. A duplicate event reaches the saga

SQS standard queues deliver at least once, and once in a while `OrderPlaced` arrives at the saga starter twice. The second `StartExecution` with the same name and identical input returns the running execution, or `ExecutionAlreadyExists` if it has finished. One saga, one stock reservation, one warehouse release.

### 4. The warehouse goes down for 3 hours

At 14:00 the WMS starts returning 503. If the worker just throws, each message is retried after the visibility timeout and reaches `maxReceiveCount` within minutes, so the DLQ fills with 30 orders per second of perfectly valid work.

Instead, the worker treats repeated 503s as a circuit breaker: after 20 consecutive failures, it disables its own event source mapping (`UpdateEventSourceMapping` with `Enabled: false`) and raises an alarm. Messages wait in the queue; the sagas wait on their task tokens, which have a 48-hour timeout. At 17:00 the warehouse recovers and on-call re-enables the mapping. The backlog of about 324,000 messages (30 per second for 3 hours) drains at a net 70 per second in about 77 minutes. No orders are lost and none are cancelled.

### 5. One bad order blocks the ERP

An order with a currency code the ERP mapping doesn't know makes the ERP sync throw. In the FIFO queue, that message's group is blocked while it's retried, but every other order keeps flowing, because each order is its own group. After 5 receives the message moves to the FIFO DLQ and the alarm fires. To stop the order's later changes from overtaking it, the ERP sync checks the version: if it receives `v4` but the ERP has `v2`, it fails that message too, and the rest of the order follows it into the DLQ. Finance adds the currency mapping and redrives the DLQ to the source queue. One order was delayed by an hour; 40,000 others weren't affected.

### 6. A bug corrupts the orders view

A deploy at 06:00 writes the wrong delivery date into the customer-service orders view. The bug is found at 12:00. After the fix, you replay the archive for 06:00 to 12:00 back onto the bus. Replayed events carry a `replay-name` field, and every rule except the projection's excludes them:

```json
{
  "source": ["shop.orders"],
  "detail-type": ["OrderPlaced", "OrderShipped"],
  "replay-name": [{ "exists": false }]
}
```

So the projection rebuilds the view, and nobody gets a second "your order has shipped" email. If you set up archive and replay without this filter, find out before the first replay, not during it.

## Security

- **Least privilege per function.** The notifier can read orders and send email; it can't touch payments. The WMS worker can call `SendTaskSuccess` and `SendTaskFailure` on one state machine.
- **Bus resource policy** so only the pipe can put events with `source: shop.orders`. Other teams can create rules; they can't forge order events.
- **Encryption.** SQS server-side encryption on every queue, DynamoDB encryption at rest, and a customer managed KMS key on the event bus and archive if your compliance team requires it.
- **No card data anywhere in the event flow.** The payment provider holds the card; you hold a reference.
- **The warehouse webhook** that calls `SendTaskSuccess` sits behind API Gateway with a shared secret or mutual TLS, and validates that the task token belongs to the order in the request.
- **Secrets** for the payment and warehouse APIs live in Secrets Manager, or in an EventBridge connection for the Step Functions HTTP Task.

## What it costs

Rough monthly cost for 2 million orders, using on-demand list prices in US East (N. Virginia) in November 2026, without the free tier. Treat it as an order of magnitude and run your own numbers in the [AWS Pricing Calculator](https://calculator.aws/).

| Service | Usage per month | Approx. cost |
| --- | --- | --- |
| Step Functions Standard | 2M executions x ~8 state transitions = 16M transitions at $0.025 per 1,000 | $400 |
| Lambda (Arm) | ~20M invocations, ~1.5M GB-seconds | $25 |
| DynamoDB on-demand | ~34M write units, ~10M read units, stream reads | $25 |
| SQS (standard + FIFO) | ~50M requests | $23 |
| EventBridge | ~14M custom events, archive | $16 |
| EventBridge Pipes | ~16M requests after filtering | $7 |
| API Gateway (REST) + AWS WAF | 2M requests, one web ACL | $18 |
| CloudWatch and X-Ray | logs, ~20 alarms, sampled traces | $20 |
| Data Firehose to S3 | ~14M small records | $2 |
| **Total** | | **about $540, or $0.00027 per order** |

That is comfortably under the tenth-of-a-cent target. Email is extra: 4 million messages through SES is about $400, which is the price of email, not of the architecture.

The number to notice is Step Functions: three quarters of the bill. Standard workflows are priced per state transition, so **every state you add costs money at scale**. Keep the saga lean: no Pass states for formatting (use the pipe's input transformer and the task's parameters), no polling loops (use task tokens), and keep fan-out side effects like emails out of the workflow and on the bus. At 2 million orders a month, $400 for an exactly-once, auditable workflow per order is a bargain. At 50 million, it's $10,000, and it is worth moving the short, synchronous parts into a nested Express workflow.

## The Well-Architected review

| Pillar | Decision in this design | Why it matters |
| --- | --- | --- |
| **Operational excellence** | One workflow per order, viewable in the console; X-Ray traces and `orderId` on every event; alarms on age and DLQ depth; reconciliation job; runbooks for redrive and replay | When a customer calls, support can see exactly where the order is in under a minute |
| **Security** | Least-privilege role per function; bus resource policy; no card data in events; KMS encryption; secrets in Secrets Manager | A compromised notifier can't touch payments, and the bus stays out of PCI scope |
| **Reliability** | Loosely coupled through queues (REL04-BP02); idempotent operations at every hop (REL04-BP04); throttling with maximum concurrency (REL05-BP02); limited retries with backoff and jitter (REL05-BP03); bounded retries and DLQs so queues don't grow forever (REL05-BP04); multi-AZ managed services | A warehouse or ERP outage degrades one path; order intake keeps working |
| **Performance efficiency** | Synchronous path is one Lambda and one write; everything else is asynchronous; FIFO only where order matters, partitioned by order | Checkout latency doesn't depend on the slowest downstream system |
| **Cost optimization** | Serverless, pay per use, scales to almost nothing overnight; lean state machine; Arm Lambdas; side effects on the bus, not in the workflow | About $0.00027 per order, with the main cost driver known and controllable |
| **Sustainability** | No idle servers; queues smooth peaks so downstream systems are sized for the average, not the spike | The warehouse doesn't need capacity for 400 requests per second it would use for 10 minutes a year |

The [Serverless Applications Lens](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/welcome.html) is worth reading alongside the main framework for this kind of system. Most of its event-driven guidance shows up in the design above.

## How to test it

- **Load test the peak, not the average.** Replay 400 orders per second for 10 minutes against a staging stack with a mock warehouse limited to 100 requests per second. Watch the queue drain and measure the time to empty against the 60-minute SLO.
- **Test every failure path in CI.** Send a message that makes each consumer throw and assert it lands in the right DLQ. Send `SendTaskFailure` with each custom error and assert the saga takes the right branch.
- **Inject faults.** AWS Fault Injection Service can add latency or errors to Lambda functions. Use it to prove the circuit breaker in scenario 4 actually trips.
- **Practise redrive and replay** before you need them, and write the runbook while you do.

## Checklist

- [ ] One conditional write on the synchronous path; the DynamoDB stream is the outbox
- [ ] Every event has `orderId`, `version`, `occurredAt` and no card data
- [ ] Every EventBridge target is an SQS queue with a DLQ and a retry policy
- [ ] Every queue has a DLQ, `maxReceiveCount`, a visibility timeout of 6x the function timeout, and DLQ retention longer than the source
- [ ] `ReportBatchItemFailures` on every SQS event source mapping
- [ ] Saga is Standard, named after the order ID, with Retry and Catch on every Task
- [ ] The pivot is marked; compensation before, forward recovery after
- [ ] Idempotency keys on the API, every consumer, and every payment and warehouse call
- [ ] FIFO fed from the stream for consumers that need order; version checks everywhere else
- [ ] `MaximumConcurrency` sized to each downstream limit; circuit breaker for outages
- [ ] Alarms on `ApproximateAgeOfOldestMessage`, DLQ depth, `FailedInvocations` and `ExecutionsFailed`
- [ ] Rules exclude replayed events unless they are meant to rebuild state
- [ ] Reconciliation job for orders stuck in one status
- [ ] Redrive and replay runbooks, tested

## Download the diagrams

All four diagrams are editable draw.io files using the official AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change them to fit your own system.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-event-driven-orders/aws-event-driven-orders.drawio)
- [Event-driven order processing on AWS: architecture](/assets/diagrams/aws-event-driven-orders/order-events-hld.drawio)
- [The order saga in Step Functions](/assets/diagrams/aws-event-driven-orders/order-saga.drawio)
- [Where every failed order event goes](/assets/diagrams/aws-event-driven-orders/order-failures.drawio)
- [Ordering and backpressure](/assets/diagrams/aws-event-driven-orders/order-ordering-backpressure.drawio)

Quotas and prices are as of November 2026 and change often. Check the current service quotas for your Region before you size anything.

## References

- [AWS Well-Architected Framework: Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)
- [AWS Well-Architected Serverless Applications Lens](https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/welcome.html)
- [Amazon EventBridge Pipes](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes.html)
- [Using dead-letter queues to process undelivered events in EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-dlq.html)
- [Archiving and replaying events in EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-archive.html)
- [Change data capture for DynamoDB Streams](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html)
- [Using Lambda with Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
- [Configuring scaling behavior for SQS event source mappings](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html)
- [Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [High throughput for FIFO queues in Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html)
- [Amazon SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- [Choosing a workflow type in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
- [StartExecution API reference](https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html)
- [Discover service integration patterns in Step Functions (wait for a callback with a task token)](https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html)
- [Handling errors in Step Functions workflows](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)
- [Restarting state machine executions with redrive](https://docs.aws.amazon.com/step-functions/latest/dg/redrive-executions.html)
- [Powertools for AWS Lambda (Python): Idempotency](https://docs.powertools.aws.dev/lambda/python/latest/utilities/idempotency/)
- [Amazon Builders' Library: Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
- [Amazon Builders' Library: Avoiding insurmountable queue backlogs](https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/)
- [AWS Step Functions pricing](https://aws.amazon.com/step-functions/pricing/)
