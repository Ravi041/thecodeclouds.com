---
title: "IoT and edge ingestion on AWS: a reference architecture for a million connected devices"
description: "How to connect, identify, update and store data from a fleet of 1,000,000 devices on AWS: IoT Core with MQTT and Basic Ingest, X.509 identity with fleet provisioning and a pre-provisioning hook, Greengrass for sites that go offline, and time-series storage chosen by query pattern. Requirements, sizing and cost math, five production scenarios, Well-Architected mapping and four editable draw.io diagrams."
date: 2026-11-21T03:13:00Z
category: Cloud & DevOps
coverLabel: "A million devices.\nOne message\nevery 5 minutes."
coverCode: "3,333 msg/s · 0.6¢ per device per month"
coverLogos: "aws"
coverImage: /assets/images/covers/aws-iot-edge-ingestion-architecture.jpg
coverImageAlt: "Cloud & DevOps cover reading 'A million devices. One message every 5 minutes.', with the AWS logo."
---
Connecting ten devices to AWS IoT Core is a tutorial. Connecting a million is a different job, and most of the hard parts are not in the cloud. They are in the firmware that decides when to reconnect, in the factory that decides how a device gets its identity, and in the storage design that decides whether "show me last week" costs a millisecond or a table scan.

This article is the architecture I'd use for a fleet of that size on AWS today, built around one concrete example: a heat pump manufacturer with 1,000,000 connected units in homes across Europe and the US, plus 400 supermarkets whose refrigeration is monitored through an on-site gateway. The numbers are worked out, the trade-offs are named, and each decision is tied back to the [AWS Well-Architected IoT Lens](https://docs.aws.amazon.com/wellarchitected/latest/iot-lens/iot-lens.html).

There are four diagrams, each an editable `.drawio` file built with the AWS shapes that ship with draw.io, and five production scenarios at the end.

## The short version

- **Speak MQTT over mutual TLS, one X.509 certificate per device.** No shared secrets, no API keys in firmware. The private key is generated inside a secure element and never leaves it.
- **Use fleet provisioning with a pre-provisioning hook**, or just-in-time provisioning with your own CA, so a million devices get their identity without anyone touching a console.
- **Batch on the device and publish through Basic Ingest.** Five samples per message and the `$aws/rules/...` topic cut the IoT Core bill for this fleet from about $47,000 to about $6,000 a month.
- **Put a stream between the rules engine and your databases.** Kinesis Data Streams absorbs reconnect storms and lets you replay. Rules never write straight into the database you query.
- **Design for offline as the normal case.** Devices buffer with their own timestamps, reconnect with jittered backoff, and keep persistent sessions; sites run their safety logic locally on Greengrass.
- **Pick time-series storage by the question, not by the word "time-series".** Per-device history is a key lookup in DynamoDB; fleet trends go to Timestream for InfluxDB; everything raw lands in Apache Iceberg tables on S3.
- **Roll firmware out in waves with health gates**, because "the device rebooted fine" is not the same as "the device works".

## Requirements

Architecture without requirements is decoration, so here is what this design has to meet. Every number below is used later.

### Functional

| # | Requirement |
|---|---|
| F1 | 1,000,000 heat pumps (600,000 in the EU, 400,000 in the US) report 12 measurements once a minute |
| F2 | Fault codes (compressor trip, sensor failure, refrigerant pressure) reach the owner's app and the installer within 10 seconds |
| F3 | Owners change setpoints and schedules from the app; an online device applies them within 5 seconds, an offline one when it reconnects |
| F4 | 400 supermarkets with about 300 case sensors each are monitored through one gateway per site; a warm case triggers a local alarm even with no internet |
| F5 | Firmware updates reach the whole fleet within 14 days, in stages, with automatic stop on failures |
| F6 | Owners see their unit's last 7 days minute by minute and two winters at 15-minute resolution |
| F7 | Engineering can query the full raw history for warranty, defect and year-over-year analysis |

### Non-functional

| # | Requirement | Target |
|---|---|---|
| N1 | Ingestion availability | 99.9% per month, and no data loss for samples a device has buffered |
| N2 | Offline tolerance | Home devices buffer 24 hours; sites buffer 7 days |
| N3 | Identity | Unique identity per device; a compromised device can only act as itself; revoke within 15 minutes |
| N4 | Data residency | EU device data is processed and stored in the EU |
| N5 | Scale | Growth of 25% a year without redesign; survive 180,000 devices reconnecting at once |
| N6 | Retention | Raw samples 13 months; 1-minute per-device data 90 days; 15-minute rollups 2 years |
| N7 | Cost | IoT Core messaging, connectivity and rules under 1 cent per device per month |

N4 decides the first big shape of the design: two independent regional stacks, `eu-central-1` for the EU fleet and `us-east-1` for the US fleet, each a full copy of everything below. A device's home region is baked into its provisioning, and nothing crosses the Atlantic except aggregated, non-personal metrics.

## The reference architecture

<figure class="diagram wide"><a href="/assets/diagrams/aws-iot-edge-ingestion/aws-iot-reference.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-iot-edge-ingestion/aws-iot-reference.svg" alt="Reference architecture for one regional stack, eu-central-1, with us-east-1 running the same stack for the US fleet. On the left, the home fleet of 1,000,000 heat pumps runs FreeRTOS with coreMQTT and a key in a secure element, takes one sample per minute and sends five samples per message, one message every five minutes, buffering 24 hours in flash when offline and sending fault codes at once with QoS 1. Below it, 400 supermarkets have case sensors over Modbus RTU and a refrigeration controller connected to a Greengrass core on an industrial PC, which runs local alarm logic when the WAN is down and buffers 7 days on disk. Both connect over mutual TLS to AWS IoT Core (step 1), which contains the device gateway (MQTT 5 over TLS on port 8883 or 443 with ALPN), the registry and X.509 authentication with policy variables, Device Shadow with a named shadow called config, the rules engine with Basic Ingest, Jobs for staged OTA updates, and fleet provisioning. Device Defender, Device Management and CloudWatch sit beside it. Rules fan out: R1 telemetry goes to Kinesis Data Streams keyed by thing name (step 2), then to Managed Service for Apache Flink for dedupe, rollups and anomalies, then to Timestream for InfluxDB for fleet and site aggregates and on to Managed Grafana; Kinesis also feeds Data Firehose (step 3), which writes raw samples into S3 Tables in Iceberg format for 13 months, queried by Athena and QuickSight. R2 alarms go to an SQS queue with a dead-letter queue (step 4), a Lambda function that enriches and deduplicates, and SNS mobile push to owner and installer. R3 presence events go to a Lambda function (step 5) that writes the online flag into a DynamoDB device_state table, which also holds the latest sample written by Flink. The owner app calls API Gateway with Cognito, then a Lambda function that reads device_state and sets the shadow's desired state. Every rule has an error action to an S3 bucket." width="1500" height="960" loading="lazy"></a><figcaption>One regional stack. Numbers match the walkthrough below; us-east-1 runs an identical copy for the US fleet.</figcaption></figure>

1. **Devices connect over MQTT with mutual TLS.** Heat pumps use FreeRTOS and coreMQTT; the gateway at each supermarket runs AWS IoT Greengrass. Both authenticate with their own X.509 certificate. Port 8883 is the default; port 443 with the `x-amzn-mqtt-ca` ALPN value gets through hotel and corporate firewalls that only allow HTTPS.
2. **Telemetry goes through Basic Ingest into Kinesis Data Streams.** A device publishes to `$aws/rules/telemetry/hp/<thing>/telemetry`. That reserved prefix sends the message straight to the rule named `telemetry` without passing through the publish/subscribe broker, so there is no messaging charge for it. The rule's only action is a Kinesis put with the thing name as partition key, which keeps each device's samples in order.
3. **The stream fans out.** A Managed Service for Apache Flink application deduplicates, builds per-device windows and fleet aggregates. Amazon Data Firehose reads the same stream and writes every raw sample into an Apache Iceberg table in S3 Tables.
4. **Alarms take a separate, faster path.** Fault codes are published to `hp/<thing>/alarm` with QoS 1. Rule R2 filters on severity and sends to SQS; a Lambda function enriches the alarm with the owner and installer, suppresses duplicates, and sends push notifications. Ten seconds end to end is easy because nothing here is batched.
5. **Connectivity is tracked from lifecycle events.** IoT Core publishes connect and disconnect events to `$aws/events/presence/...`. Those events can arrive out of order, so rule R3 sends them to a Lambda function that only updates the `online` flag if the event is newer than what is stored.

Commands go the other way through the **Device Shadow**. The app never talks MQTT. It calls API Gateway, and a Lambda function writes the new setpoint into the `desired` section of the device's named shadow `config`. If the device is online it receives a delta within a second and replies with `reported`. If it is offline, the desired state simply waits. That's F3 without any custom queueing.

Every rule has an **error action** that writes failed action payloads to an S3 bucket. Without it, a throttled Kinesis put or a missing permission silently drops data, and you find out from a customer.

### Why these choices

| Decision | Chosen | Instead of | Because |
|---|---|---|---|
| Protocol | MQTT 5 | HTTPS publish | One long-lived connection: commands reach the device in under a second, and the TLS handshake happens once, not every 5 minutes. MQTT 5 adds message expiry and session expiry the device can request |
| Telemetry topic | Basic Ingest | Normal topic + rule | No messaging charge, and no backend subscribers need telemetry from the broker |
| Rule target | Kinesis Data Streams | DynamoDB or a TSDB action directly | Buffer for storms, ordered per device, replayable for 7 days, and the consumers can be redeployed without touching the rules |
| Stream processing | Managed Service for Apache Flink | Lambda on the stream | Event-time windows, dedupe state and late data handling are built in. Lambda works at small scale but you end up rebuilding windowing |
| Commands | Device Shadow | Custom command topics + DynamoDB | Offline delivery and desired/reported reconciliation come for free |
| Alarms, analytics on AWS IoT | Rules + SQS + Lambda, Flink, Athena | AWS IoT Events, AWS IoT Analytics | Both services have [reached end of support](https://docs.aws.amazon.com/iotevents/latest/developerguide/iotevents-end-of-support.html). Don't start new designs on them |

If your devices are industrial assets with a hierarchy (plant, line, machine, sensor) and your users are process engineers, look at AWS IoT SiteWise instead of building the asset model yourself. For a consumer product fleet like this one, the rules engine and a stream are the simpler fit.

### The limits that shape the design

AWS IoT Core quotas are generous, but a few of them decide how the device firmware must behave, so read the [AWS IoT Core quotas page](https://docs.aws.amazon.com/general/latest/gr/iot-core.html) before you freeze the firmware. These are the defaults at the time of writing:

| Quota | Default | What it means for this fleet |
|---|---|---|
| Connect requests per second per account | 3,000 in most large regions, 100 in some; adjustable | 180,000 devices reconnecting together need at least a minute even when perfectly spread. Backoff with jitter is mandatory |
| Connect requests per second per client ID | 1, not adjustable | A device stuck in a tight reconnect loop throttles itself |
| Inbound publish requests per second per account | 20,000 in large regions; adjustable | Fine at 3,333 msg/s average; batching keeps headroom for storms |
| Rule evaluations per second per account | 20,000 in large regions, including Basic Ingest; adjustable | Same budget as above, shared by all rules |
| MQTT payload size | 128 KB, not adjustable | Five samples is about 1.2 KB. Large files go to S3 with a presigned URL, never over MQTT |
| Unacknowledged inbound QoS 1 publishes per client | 100, not adjustable | Backlog upload has to wait for PUBACKs, not fire and forget |
| Actions per rule | 10 | One reason the design fans out from a stream, not from the rule |
| Device Shadow document | 8 KB by default | Keep the shadow to configuration and a few status fields, not telemetry |

## Device identity and fleet provisioning

Identity is the part you can't fix after the devices ship. A million units with a shared password in firmware is a million units one teardown away from being impersonated.

<figure class="diagram wide"><a href="/assets/diagrams/aws-iot-edge-ingestion/aws-iot-identity.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-iot-edge-ingestion/aws-iot-identity.svg" alt="Device identity flow. In the factory, the contract manufacturer's end-of-line station has the secure element generate the key pair so the private key never leaves the chip, records the serial, public key hash and batch ID, and ships firmware with a claim certificate shared by one production batch of about 20,000 units. Step 1: the signed batch manifest is uploaded to an S3 bucket in eu-central-1, and an import Lambda function writes one allow-list row per serial into DynamoDB. Step 2: at first boot at the customer, the heat pump connects over MQTT with mutual TLS to the AWS IoT Core device gateway using the claim certificate, which may only use the certificates and provisioning-templates topics. Step 3: the device sends a certificate signing request and CreateCertificateFromCsr returns a unique certificate and an ownership token. Step 4: the device publishes RegisterThing with the provisioning template hp-prod-eu. Step 5: a pre-provisioning hook Lambda function checks that the serial is on the list, not yet claimed and that the batch is not revoked, and marks it claimed with a conditional write in DynamoDB. Step 6: the registry creates thing hp-serial, activates the certificate, attaches policy hp-device and adds the thing to group eu/heatpump; the device reconnects with its own certificate and never uses the claim certificate again. Device Defender audits for shared or expiring certificates and loose policies, and its Detect mitigations can move a thing to a quarantine group and set its certificate inactive. A policy box shows the single hp-device policy using the policy variable iot:Connection.Thing.ThingName so each device may only connect as its own client ID, publish to its own telemetry and alarm topics, and subscribe to its own shadow and jobs topics. An option B box describes just-in-time provisioning with your own CA, where no claim certificate exists." width="1500" height="910" loading="lazy"></a><figcaption>From the factory line to a unique certificate, with a claim certificate that can do almost nothing on its own.</figcaption></figure>

### Pick a provisioning method

AWS IoT Core offers several [device provisioning](https://docs.aws.amazon.com/iot/latest/developerguide/programmatic-provisioning.html) options. For a fleet this size, two are realistic:

- **Just-in-time provisioning (JITP) with your own CA.** The chip vendor or your factory PKI signs a unique device certificate during manufacturing. You register that CA with IoT Core and attach a provisioning template to it. On first connect, IoT Core creates the thing automatically. There is no shared secret anywhere. This is the stronger option if your supply chain can run a signing step on the line.
- **[Fleet provisioning by claim](https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html).** Firmware ships with a claim certificate shared by a production batch. On first boot the device uses it to request its own certificate. This works when the factory can't sign certificates, which is common with contract manufacturers.

This design uses fleet provisioning by claim, because the heat pumps are built by two contract manufacturers on different continents. The risk with claim certificates is obvious: if one leaks, anyone can call the provisioning API. Three controls make that leak close to harmless:

1. **The claim certificate's policy only allows the provisioning topics.** It can't publish telemetry, read shadows or subscribe to anything else.
2. **The private key is generated in the secure element, and the device sends a CSR.** `CreateCertificateFromCsr` signs the device's own public key, so the private key never travels.
3. **A [pre-provisioning hook](https://docs.aws.amazon.com/iot/latest/developerguide/pre-provisioning-hook.html) checks the factory record.** Before IoT Core creates anything, it calls a Lambda function with the template parameters and certificate ID. The function checks the serial against the allow-list loaded from the factory manifest, compares the certificate's public key hash with the one recorded on the line, and marks the serial as claimed with a DynamoDB conditional write. A serial registers once, and only with the key that was born in that chip.

The allow-list is loaded from signed batch manifests that the manufacturer uploads to S3 before units leave the factory. A unit that isn't on a manifest cannot join the fleet, however good its claim certificate.

### One policy for a million devices

You don't want a million IoT policies. One policy with [policy variables](https://docs.aws.amazon.com/iot/latest/developerguide/thing-policy-variables.html) covers the fleet:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "iot:Connect",
      "Resource": "arn:aws:iot:eu-central-1:111122223333:client/${iot:Connection.Thing.ThingName}",
      "Condition": { "Bool": { "iot:Connection.Thing.IsAttached": "true" } }
    },
    {
      "Effect": "Allow",
      "Action": "iot:Publish",
      "Resource": [
        "arn:aws:iot:eu-central-1:111122223333:topic/$aws/rules/telemetry/hp/${iot:Connection.Thing.ThingName}/telemetry",
        "arn:aws:iot:eu-central-1:111122223333:topic/hp/${iot:Connection.Thing.ThingName}/alarm",
        "arn:aws:iot:eu-central-1:111122223333:topic/$aws/things/${iot:Connection.Thing.ThingName}/shadow/name/config/*",
        "arn:aws:iot:eu-central-1:111122223333:topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "iot:Subscribe",
      "Resource": [
        "arn:aws:iot:eu-central-1:111122223333:topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/shadow/name/config/*",
        "arn:aws:iot:eu-central-1:111122223333:topicfilter/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "iot:Receive",
      "Resource": [
        "arn:aws:iot:eu-central-1:111122223333:topic/$aws/things/${iot:Connection.Thing.ThingName}/shadow/name/config/*",
        "arn:aws:iot:eu-central-1:111122223333:topic/$aws/things/${iot:Connection.Thing.ThingName}/jobs/*"
      ]
    }
  ]
}
```

The `IsAttached` condition means a certificate can only connect with the client ID of the thing it's attached to. Combined with the variables, a stolen or cloned device can only ever speak as itself. It can't read another unit's shadow, can't publish someone else's telemetry and can't subscribe to `#`.

### Keeping identity healthy for ten years

Heat pumps live 15 years; certificates and CAs don't. Plan the lifecycle on day one:

- **Audit continuously.** [AWS IoT Device Defender audit](https://docs.aws.amazon.com/iot-device-defender/latest/devguide/device-defender-audit.html) checks for the same certificate used by several devices, overly permissive policies, and CA or device certificates close to expiry. Schedule it daily and send findings to Security Hub.
- **Detect behaviour.** Device Defender Detect watches per-device metrics such as messages sent, authorisation failures and connection attempts, with fixed thresholds or ML-learned baselines. A mitigation action can move the thing to a quarantine thing group whose policy only allows the jobs topics, or set its certificate to `INACTIVE`. That's how N3's "revoke within 15 minutes" is met.
- **Rotate with a job, not a recall.** A certificate rotation is a Job that asks the device to generate a new key in its secure element, send a CSR, and switch over after the new certificate works. Run it years before expiry, in waves, like any other update.

## Edge and offline: assume the network is down

Offline isn't an edge case for an IoT fleet. At a million devices, thousands are offline at any moment because of home Wi-Fi, router reboots, ISP faults and power cuts. The design has to treat a reconnect with a backlog as a normal Tuesday.

<figure class="diagram wide"><a href="/assets/diagrams/aws-iot-edge-ingestion/aws-iot-edge-offline.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-iot-edge-ingestion/aws-iot-edge-offline.svg" alt="Edge and offline behaviour. A supermarket site with a Greengrass gateway has its WAN down from 06:10 to 12:10. Case sensors (300, Modbus RTU, one reading every 10 seconds) and the refrigeration controller feed a Modbus adapter component on the Greengrass core device, an industrial PC with a 64 GB SSD. The adapter publishes to local pub/sub over Greengrass IPC with no cloud round trip. A case-temperature logic component raises an alarm if a case is warmer than minus 15 degrees for 15 minutes and starts a defrost lockout (step 1), driving the store alarm panel and staff pager within seconds while offline. A stream manager component (step 2) keeps a 4 GB disk stream covering 7 days and exports in order to Kinesis; a shadow manager keeps local setpoint shadows and syncs on reconnect; the nucleus with the disk spooler (step 3) keeps QoS 1 alarms on disk until IoT Core acknowledges them. All components ship as one deployment to the thing group sites/eu. The site router and 4G backup are both down, so the traffic to AWS IoT Core and Kinesis Data Streams is buffered and then drained. Below, a heat pump at home with Wi-Fi down for 40 minutes (step 4) keeps writing one-minute samples of about 40 bytes in CBOR into a 64 KB flash ring buffer holding 24 hours, with the device timestamp on every sample; it reconnects with exponential backoff and full jitter from 1 second to a 5-minute cap, uses MQTT 5 with clean start 0 and a 24-hour session expiry so QoS 1 commands sent while it was away are delivered, and uploads the backlog oldest first at no more than 2 messages per second after receiving the latest shadow. In the AWS Cloud (step 5), IoT Core persistent sessions hold QoS 1 messages for offline devices, Device Shadow keeps new setpoints in desired, Kinesis receives the site backlog in order with original timestamps, IoT Greengrass deployments queue until the core is back, and a presence rule with CloudWatch alerts if a site is silent for more than 15 minutes. A note says late data is normal: downstream stores key on device time and accept samples days late." width="1500" height="840" loading="lazy"></a><figcaption>The site keeps its safety logic running locally; the cloud catches up when the link returns. The home device does the same thing with a 64 KB buffer.</figcaption></figure>

### The supermarket gateway: Greengrass

A supermarket can't wait for the cloud to decide that a freezer case is warm. The logic that matters for food safety runs on the [AWS IoT Greengrass](https://docs.aws.amazon.com/greengrass/v2/developerguide/what-is-iot-greengrass.html) core device in the store, as components:

- **A Modbus adapter** reads the case sensors and the refrigeration controller and publishes readings on local IPC topics. Nothing about this path needs the internet.
- **A case-temperature component** subscribes locally, raises the store alarm panel within seconds, and writes the alarm to the cloud through the MQTT connection.
- **Stream manager** writes every reading to a local disk-backed stream and exports it to Kinesis Data Streams in order when the link is up. Size it for the outage you want to survive: 300 sensors × one reading every 10 seconds × about 150 bytes is roughly 16 MB an hour, so 7 days (N2) is under 3 GB. Set a stream size with headroom and choose `OverwriteOldestData` so a very long outage loses the oldest readings, not the newest.
- **The [disk spooler](https://docs.aws.amazon.com/greengrass/v2/developerguide/disk-spooler-component.html)** keeps the nucleus's outbound MQTT messages, here the QoS 1 alarms, on disk instead of in memory, so a gateway reboot during an outage doesn't lose them.
- **Shadow manager** keeps local shadows for setpoints, so the store manager can change a case temperature on the local screen while offline and the change syncs when the link returns.

All of it is one Greengrass deployment targeted at the `sites/eu` thing group. Components are versioned recipes with artifacts in S3, and a deployment that can't reach a core waits until the core is back.

### The heat pump: firmware rules for a well-behaved fleet

The heat pumps run on microcontrollers, not Linux, so Greengrass isn't an option. The same ideas live in the firmware instead, and these rules matter more than anything in the cloud:

1. **Buffer with device timestamps.** Every sample carries the time it was taken, from an NTP-synced clock. A 64 KB flash ring buffer holds 24 hours of one-minute samples at about 40 bytes each in CBOR. When the buffer is full, the oldest data goes first.
2. **Reconnect with exponential backoff and full jitter.** Start at 1 second, double up to a 5-minute cap, and pick a random wait between zero and the current ceiling. Without jitter, a regional ISP fault turns into a synchronised connect storm every few seconds.
3. **Use persistent sessions.** Connect with MQTT 5 `clean start = 0` and a session expiry interval of 24 hours (within the account's configured maximum). IoT Core then holds QoS 1 messages published to the device's subscriptions while it's away and delivers them on reconnect.
4. **Sync state before history.** After reconnecting, get the shadow first so the device acts on the newest setpoint, then upload the backlog oldest first, at most 2 messages a second and waiting for PUBACKs.
5. **Never trust your own retry.** QoS 1 means at least once, so the same sample can arrive twice. Everything downstream dedupes on `(thing, sample_ts)`.

On the cloud side, a rule on the [lifecycle events](https://docs.aws.amazon.com/iot/latest/developerguide/life-cycle-events.html) keeps the online flag, and a CloudWatch alarm fires when a supermarket gateway has been disconnected for more than 15 minutes. For homes, you don't alert on individual disconnects; you alarm on the *fraction* of a country's fleet that is offline compared with the same hour last week, which is how you spot an ISP outage or a bad firmware build within minutes.

## Time-series storage by query pattern

"Use a time-series database" is the reflex answer for IoT data, and it's half right. The trouble is that a fleet asks very different questions of the same data, and one store is rarely best at all of them.

<figure class="diagram wide"><a href="/assets/diagrams/aws-iot-edge-ingestion/aws-iot-time-series.svg" title="Open the full-size diagram"><img src="/assets/diagrams/aws-iot-edge-ingestion/aws-iot-time-series.svg" alt="Time-series storage for the EU region with 600,000 devices. Kinesis Data Streams hp-telemetry-eu receives 2,000 records per second, 2.4 MB per second, on 8 shards for 3x headroom. It feeds one Managed Service for Apache Flink application with three operators: dedupe keyed on thing and sample timestamp with 48 hours of state, so backlog uploads and QoS 1 retries become no-ops; per-device event-time windows that build hourly blocks of 60 one-minute samples and 15-minute rollups, allowing 48 hours of late data; and fleet aggregates per country, model and firmware with a compressor short-cycling detector. Outputs: DynamoDB device_state with the latest sample per device, written only if the sample timestamp is newer; DynamoDB device_history with one item per device-hour kept 90 days and one item per device-day of rollups kept 2 years; Timestream for InfluxDB with fleet and site aggregates, around 50,000 series, for Grafana boards; and EventBridge with anomaly events to field-service tickets and the owner app. Kinesis also feeds Data Firehose with 5-minute or 128 MB buffers, writing Parquet into an Iceberg table raw.telemetry in S3 Tables, partitioned by day of sample timestamp, kept 13 months with managed compaction, queried by Athena, QuickSight and SageMaker. A box maps questions to stores: is my heat pump on goes to device_state with one GetItem; last week minute by minute goes to device_history with one Query of 168 items; which firmware has more defrost faults goes to InfluxDB aggregates or Athena; this winter against last winter goes to Athena over Iceberg. A sizing box gives the numbers used in the article." width="1500" height="800" loading="lazy"></a><figcaption>One stream, four stores. Each answers the questions it's good at.</figcaption></figure>

| Question | Who asks | Store | Access |
|---|---|---|---|
| Is my heat pump on, and how warm is it? | Owner app, many times a day | DynamoDB `device_state` | One `GetItem`, single-digit milliseconds |
| Show last week minute by minute | Owner app, support | DynamoDB `device_history` | One `Query` returning 168 hourly items |
| Which firmware has more defrost faults right now? | Engineering, operations | Timestream for InfluxDB | Aggregates by country, model, firmware |
| Compare this winter with last; warranty claims | Engineering, data science | S3 Tables (Iceberg) + Athena | SQL, pruned by day partition |

**Per-device history is a key lookup.** The Flink job collects each device's samples into one item per device-hour (60 one-minute samples, about 4 KB), and a second item per device-day with 96 fifteen-minute rollups. A week of charts is a single `Query` on the partition key. At 600,000 EU devices that's about 167 writes per second, with a TTL of 90 days on hourly items (N6). Writing one item per sample instead would be 10,000 writes a second for the same data.

**Fleet trends go to a time-series database, without a tag per device.** [Amazon Timestream for InfluxDB](https://docs.aws.amazon.com/timestream/latest/developerguide/timestream-for-influxdb.html) holds aggregates by country, model, firmware version and supermarket site, plus the site sensors at full resolution. That's tens of thousands of series. If you tagged every point with the device ID, 600,000 devices × 12 fields would be 7.2 million series, which is exactly the high-cardinality pattern that makes a time-series database slow and expensive. Note that Amazon Timestream for LiveAnalytics [closed to new customers](https://docs.aws.amazon.com/timestream/latest/developerguide/AmazonTimestreamForLiveAnalytics-availability-change.html) in June 2025; for new builds, AWS points to Timestream for InfluxDB.

**Everything raw goes to Iceberg.** Firehose writes every raw sample, duplicates included, into an Apache Iceberg table in S3 Tables, partitioned by day of the device timestamp. Athena queries it for warranty and year-over-year work, and SageMaker trains the anomaly models on it. Queries dedupe on `(thing, sample_ts)`, or a nightly job rewrites the day's partition without duplicates. Compaction and snapshot cleanup are managed by S3 Tables. Partitioning on device time, not arrival time, is what makes a three-day-late backlog land in the right place.

**Late data is the normal case.** The Flink windows use event time with 48 hours of allowed lateness. `device_state` is only overwritten when the incoming `sample_ts` is newer than the stored one, using a DynamoDB condition expression; otherwise a backlog upload after a Wi-Fi outage would roll the app's "current temperature" back by 40 minutes.

## Sizing and cost

### Throughput

| | EU | US | Fleet |
|---|---|---|---|
| Devices | 600,000 | 400,000 | 1,000,000 |
| Messages per second (1 every 5 min) | 2,000 | 1,333 | 3,333 |
| Payload (5 samples, JSON) | 1.2 KB | 1.2 KB | |
| Ingest | 2.4 MB/s | 1.6 MB/s | 4.0 MB/s |
| Raw JSON per day | about 207 GB | about 138 GB | about 345 GB |
| Kinesis shards (provisioned) | 3 by throughput, 8 with storm headroom | 2, 6 with headroom | |

A Kinesis shard accepts up to 1 MB/s or 1,000 records/s of writes. Three shards carry the EU average, but after a mass reconnect the backlog arrives at several times the normal rate, so the design provisions 8. On-demand capacity mode is a reasonable alternative if you'd rather not tune shard counts.

### What batching and Basic Ingest are worth

AWS IoT Core charges for connectivity per connection-minute, for messaging per message (metered in 5 KB blocks), and for rules per rule triggered plus per action. Using the [AWS IoT Core pricing](https://aws.amazon.com/iot-core/pricing/) list prices for us-east-1 at the time of writing, and a 30-day month for the whole fleet:

| Line item | Naive: 1 msg/min to a normal topic | This design: 5 samples per msg via Basic Ingest |
|---|---|---|
| Connectivity (43.2 billion connection-minutes × $0.08 per million) | $3,456 | $3,456 |
| Messages | 43.2 billion | 8.64 billion |
| Messaging (tiered $1.00 / $0.80 / $0.70 per million) | $30,940 | $0 (Basic Ingest) |
| Rules triggered + actions ($0.15 + $0.15 per million) | $12,960 | $2,592 |
| **IoT Core total per month** | **about $47,400** | **about $6,050** |
| Per device per month | 4.7 cents | 0.6 cents |

The batched design meets N7 with room to spare. The cost is latency: a sample can be up to five minutes old when it reaches the cloud. That's fine for charts and trends, and it's why alarms (F2) and shadow updates (F3) don't batch. Prices differ by region and change over time, so rerun these numbers with the [pricing calculator](https://calculator.aws/) for your own regions before you commit firmware to a batch size.

Downstream costs (Kinesis, Flink, DynamoDB, Firehose, storage) depend heavily on your payload and retention. Two things to watch: Firehose bills ingestion in 5 KB increments per record, so very small records are relatively expensive, and DynamoDB writes are billed per KB, which is why per-device history is written as hourly blocks rather than per sample.

## Five scenarios from production

These are the situations worth rehearsing before the fleet is big. Times are local.

### 1. An ISP outage and 180,000 devices coming back at once

**What happened.** On a cold January evening, a broadband provider in one country loses its core network from 19:40 to 20:20. About 180,000 heat pumps drop off. During the outage, 22,000 owners, cold and annoyed, open the app and turn the heating up.

**What the signals showed.** The offline-fraction alarm for that country fired at 19:43, three minutes in, while every AWS metric looked normal. At 20:20 the connect rate climbed to the account's connect quota and IoT Core started throttling.

**Why it was a non-event.** The firmware's jittered backoff spread the reconnects over about five minutes, roughly 600 connects per second, comfortably under the quota once the first burst passed. The 22,000 setpoint changes were waiting in each device's shadow as `desired` and applied within a second of reconnecting. Each device then uploaded 40 minutes of buffered samples, about 8 extra messages per device, or 1.4 million messages in a few minutes. Kinesis took the burst on its 8 shards, Flink placed every sample in the right window by device time, and the charts in the app showed no gap.

**What would have gone wrong without the design.** Fixed 5-second retries would have produced a synchronised wave every 5 seconds and kept a large part of the fleet throttled for many minutes. Without device timestamps, 40 minutes of data would have appeared as a spike at 20:21.

### 2. A claim certificate posted on a forum

**What happened.** A hobbyist extracts the firmware from a scrapped controller and publishes the claim certificate and key. Within two hours, scripts make 9,000 `RegisterThing` attempts with made-up and sequential serial numbers.

**What fixed it.** Nothing needed to be fixed in a hurry. The pre-provisioning hook rejected every attempt: made-up serials were not on any manifest, and real serials failed the public-key check because the attacker couldn't produce a CSR from the key sealed in that unit's secure element. Device Defender Detect alarmed on the burst of provisioning calls from one certificate, and the team set that batch's claim certificate to `INACTIVE`, since every unit of that batch had already been sold and provisioned. New batches got a new claim certificate. Total impact: an incident ticket and a firmware note.

**The lesson.** A claim certificate is only as safe as the hook behind it. A hook that only checks "is this serial on the list" would have let an attacker claim real serials before their owners plugged them in.

### 3. A supermarket offline for six hours

**What happened.** Road works cut the fibre to a store at 06:10; the 4G backup router had an expired SIM. The link came back at 12:10.

**What happened locally.** At 08:05, a door left ajar pushed case 14 to -12 °C. The case-temperature component raised the store alarm panel and paged staff within 40 seconds, with no cloud involved. The door was shut at 08:12.

**What happened in the cloud.** The presence rule saw the gateway disconnect, and at 06:25 a ticket went to the retailer's IT team, not to a refrigeration engineer. At 12:10 stream manager exported six hours of readings, about 100 MB, in order, and the disk spooler delivered the 08:05 alarm marked with its original timestamp. The alarm Lambda function recognised it as late and already handled locally, so it logged it instead of paging the installer four hours after the fact.

### 4. A firmware update that passed every check and still broke

**What happened.** Firmware 5.3.0 went out to the EU fleet as an [AWS IoT Job](https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs.html) with an exponential rollout (starting at 50 devices per minute), an abort rule (cancel if more than 2% fail after at least 500 executions) and a 30-minute in-progress timeout. Every device rebooted cleanly and reported `SUCCEEDED`. Six hours later, on one compressor model, the defrost cycle started hanging.

**What caught it.** The rollout was in waves gated on health, not just on job status. Wave one was a 1% canary group, 6,000 devices, held for 48 hours. The Flink fleet aggregates showed the defrost-fault rate for `fw=5.3.0, model=HX-9` at 3.1% against a 0.2% baseline nine hours after install. The team stopped the rollout, used fleet indexing to find every affected unit (`attributes.fw:5.3.0 AND attributes.model:HX-9`), and sent a rollback job to 5.2.4.

**The lesson.** Job success criteria catch bricked devices. Only fleet telemetry, compared by firmware version, catches devices that boot fine and behave badly. Build the dashboard by firmware version before you need it.

### 5. A debug flag left on

**What happened.** A field-test build with verbose telemetry, one message per second, was accidentally included in a production wave of 4,000 devices. Normal is 288 messages per device per day; these sent 86,400.

**What the signals showed.** Daily messages for those devices went from about 1.2 million to about 346 million, roughly $100 a day in extra rule charges in this design and a steady extra load on the stream. Device Defender Detect had a behaviour on messages sent per device ("more than 30 in 5 minutes"), and it fired within the first hour of the wave.

**What fixed it.** A job to the affected thing group with the right build, a CI check that refuses to sign firmware with debug telemetry enabled, and a Cost Anomaly Detection monitor on AWS IoT.

## Mapping to the Well-Architected IoT Lens

| Pillar | What this design does |
|---|---|
| Operational excellence | Firmware, components, rules and infrastructure are all code; firmware rolls out as Jobs in health-gated waves; dashboards by firmware version and country; game days that cut a site's WAN and replay an ISP outage |
| Security | Unique X.509 identity per device with keys in a secure element; claim certificate limited to provisioning, behind a hook that checks the factory record; one least-privilege policy using thing-name variables; Device Defender audit and Detect with quarantine actions; certificate rotation as a planned job |
| Reliability | Devices buffer 24 hours and sites 7 days with device timestamps; jittered reconnects and persistent sessions; Kinesis between rules and stores; dedupe on `(thing, sample_ts)`; rule error actions to S3; local safety logic on Greengrass; independent regional stacks |
| Performance efficiency | Basic Ingest instead of broker fan-out; per-device ordering via partition key; stores chosen by access pattern; device history as hourly blocks; low-cardinality TSDB schema |
| Cost optimisation | Five samples per message and Basic Ingest cut IoT Core cost by about 87%; hourly blocks instead of per-sample writes; Iceberg on S3 for long retention; TTL on DynamoDB history; anomaly detection on message rates |
| Sustainability | Fewer, larger messages mean fewer radio wake-ups and TLS work on devices; compact CBOR on the wire to the buffer; aggregation at the edge for sites; data kept only as long as N6 requires |

## Checklist before you ship firmware

- Unique key generated in a secure element; claim certificate (if any) limited to provisioning topics
- Pre-provisioning hook checks serial, one-time claim and public key against the factory record
- One IoT policy with thing-name variables and `IsAttached`; no wildcards
- Reconnect with exponential backoff and full jitter; persistent session with a sensible expiry
- Local buffer sized for your offline target, with device timestamps on every sample
- Telemetry batched and sent through Basic Ingest; alarms and commands not batched
- Every rule has an error action; a stream sits between rules and databases
- Dedupe on `(thing, sample_ts)` and handle late data by event time
- Shadow for configuration and commands, not telemetry
- Jobs with rollout rates, abort thresholds and timeouts, plus health-gated waves by firmware version
- Device Defender audit scheduled and Detect behaviours on messages, connects and auth failures
- Quota increases requested for connects and publishes before the fleet reaches 50% of the defaults

If you manage the AWS side with Terraform, the account and state layout in the [Terraform on AWS enterprise guide](/blog/terraform-aws-enterprise-guide/) applies here too: one state per regional stack, and the IoT policy and provisioning template reviewed in pull requests like any other security control.

## Download the diagrams

All four diagrams are editable draw.io files using the AWS shapes that ship with draw.io. Open them in [diagrams.net](https://app.diagrams.net) or the draw.io desktop app and change the regions, device counts and table names to match your fleet.

- [All four diagrams in one file (4 pages)](/assets/diagrams/aws-iot-edge-ingestion/aws-iot-edge-ingestion.drawio)
- [Reference architecture](/assets/diagrams/aws-iot-edge-ingestion/aws-iot-reference.drawio)
- [Device identity and fleet provisioning](/assets/diagrams/aws-iot-edge-ingestion/aws-iot-identity.drawio)
- [Edge and offline behaviour](/assets/diagrams/aws-iot-edge-ingestion/aws-iot-edge-offline.drawio)
- [Time-series storage by query pattern](/assets/diagrams/aws-iot-edge-ingestion/aws-iot-time-series.drawio)

Device counts, payload sizes, prices and quotas are examples from the time of writing. Check the current quotas, prices and regional availability for your own regions before you build.

## References

- [AWS Well-Architected IoT Lens](https://docs.aws.amazon.com/wellarchitected/latest/iot-lens/iot-lens.html)
- [AWS IoT Core endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/iot-core.html)
- [Reducing messaging costs with Basic Ingest](https://docs.aws.amazon.com/iot/latest/developerguide/iot-basic-ingest.html)
- [AWS IoT rules and rule actions](https://docs.aws.amazon.com/iot/latest/developerguide/iot-rules.html)
- [Device provisioning in AWS IoT Core](https://docs.aws.amazon.com/iot/latest/developerguide/programmatic-provisioning.html)
- [Fleet provisioning for devices without certificates](https://docs.aws.amazon.com/iot/latest/developerguide/provision-wo-cert.html)
- [Pre-provisioning hooks](https://docs.aws.amazon.com/iot/latest/developerguide/pre-provisioning-hook.html)
- [Thing policy variables](https://docs.aws.amazon.com/iot/latest/developerguide/thing-policy-variables.html)
- [AWS IoT Device Shadow service](https://docs.aws.amazon.com/iot/latest/developerguide/iot-device-shadows.html)
- [Lifecycle events](https://docs.aws.amazon.com/iot/latest/developerguide/life-cycle-events.html)
- [AWS IoT Jobs](https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs.html)
- [AWS IoT Device Defender audit](https://docs.aws.amazon.com/iot-device-defender/latest/devguide/device-defender-audit.html)
- [What is AWS IoT Greengrass?](https://docs.aws.amazon.com/greengrass/v2/developerguide/what-is-iot-greengrass.html)
- [Greengrass disk spooler component](https://docs.aws.amazon.com/greengrass/v2/developerguide/disk-spooler-component.html)
- [Amazon Timestream for InfluxDB](https://docs.aws.amazon.com/timestream/latest/developerguide/timestream-for-influxdb.html)
- [Timestream for LiveAnalytics availability change](https://docs.aws.amazon.com/timestream/latest/developerguide/AmazonTimestreamForLiveAnalytics-availability-change.html)
- [AWS IoT Analytics end of support](https://docs.aws.amazon.com/iotanalytics/latest/userguide/iotanalytics-end-of-support.html)
- [AWS IoT Events end of support](https://docs.aws.amazon.com/iotevents/latest/developerguide/iotevents-end-of-support.html)
- [AWS IoT Core pricing](https://aws.amazon.com/iot-core/pricing/)
