# BullMQ runtime

`bullmq()` runs Better Flows through Redis-backed BullMQ jobs.

```bash
npm install bullmq
```

```ts
import { bullmq } from 'better-flows/bullmq'

const runtime = bullmq({
  	connection: { url: process.env.REDIS_URL! },
   	queueName: 'workflows', // optional; defaults to "better-flows"
})
```

Producers enqueue with `flows.run(flow, input)`. In a worker process, import
the module that registers the same nodes and flows, then start the worker:

```ts
import { flows } from './flows'

const worker = flows.worker()

process.on('SIGTERM', async () => worker.close())
```

Inputs and trigger occurrence `payload`/`metadata` must be JSON-serializable.
Call `runtime.close()` when a long-lived producer shuts down. Cancellation is
cooperative: nodes should honor `ctx.signal`.
