# BullMQ PostgreSQL runtime

`postgres()` runs Better Flows through BullMQ's PostgreSQL backend.

```bash
npm install bullmq pg
```

Run BullMQ's PostgreSQL migrations during deployment, then configure the
runtime with a PostgreSQL connection:

```ts
import { postgres } from 'better-flows/bullmq/postgres'

const runtime = postgres({
	connection: process.env.DATABASE_URL!,
	queueName: 'workflows', // optional; defaults to "better-flows"
})
```

Producers enqueue with `flows.run(flow, input)`. In a worker process, import
the module that registers the same nodes and flows, then start `flows.worker()`.
Inputs and trigger occurrence `payload`/`metadata` must be JSON-serializable.
Call `runtime.close()` when a long-lived producer shuts down.
