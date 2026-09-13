# Better Flows

**Type-safe workflows for TypeScript.**

Better Flows gives application workflows a small, typed model: compose normal
functions into a graph, validate boundaries at runtime, and run the same flow
in memory or with a production runtime. It is built for lead qualification,
provisioning, billing, notifications, and AI pipelines.

```bash
npm install better-flows zod
```

## Why

Queues move jobs; Better Flows models the work itself.

- Node outputs are inferred and checked before code reaches production.
- Dependencies are inferred, so independent work runs concurrently.
- Retries, timeouts, cancellation, branches, and run snapshots are built in.
- Runtimes are replaceable: use memory in tests and BullMQ in production.
- Native hooks keep observability and infrastructure out of business logic.

## A real workflow

```ts
import { betterFlows, defineNode } from 'better-flows'
import { memory } from 'better-flows/memory'
import { z } from 'zod'

const fetchLead = defineNode({
	input: z.object({ leadId: z.string() }),
	output: z.object({ leadId: z.string(), email: z.string() }),
	run: async ({ input }) => db.leads.get(input.leadId),
})

const scoreLead = defineNode({
	input: z.object({ leadId: z.string() }),
	output: z.object({ score: z.number() }),
	retry: { attempts: 3, backoff: 'exponential' },
	run: async ({ input }) => scoring.score(input.leadId),
})

const sendEmail = defineNode({
	input: z.object({ email: z.string(), score: z.number() }),
	run: async ({ input }) => mailer.send(input),
})

const flows = betterFlows({
	runtime: memory(),
	nodes: { fetchLead, scoreLead, sendEmail },
})

const qualifyLead = flows.defineFlow({
	id: 'qualify-lead',
	input: z.object({ leadId: z.string() }),
	flow: ({ input, node }) => {
		const lead = node(fetchLead, input)
		const scored = node(scoreLead, { leadId: lead.leadId })

		return node(sendEmail, { email: lead.email, score: scored.score })
  	},
})

const run = await qualifyLead.run({ leadId: 'lead_123' })

const result = await run.wait()
```

`scored.score` is known as a number. `scored.foo` is a TypeScript error before
the workflow executes.

Inspect a live run at any time:

```ts
const result = await flows.runs.get(run.id)

result.status // "running" | "completed" | "failed" | "cancelled"
result.nodes.scoreLead.output // { score: number } | undefined
```

## Conditional paths

Use `when()` for one runtime predicate, `branch()` for ordered predicates, and
`switch()` for literal string values.

```ts
branch(qualification.score, {
	hot: ({ value }) => value >= 80,
	warm: ({ value }) => value >= 40,
	cold: () => true,
}, {
	hot: () => node(notifySalesImmediately, { leadId: input.leadId }),
	warm: () => node(addToNurturing, { leadId: input.leadId }),
	cold: () => node(archiveLead, { leadId: input.leadId }),
})

when(qualification.score, ({ value }) => value >= 80, () => {
	node(notifySalesImmediately, { leadId: input.leadId })
})
```

`branch()` chooses the first matching predicate. Nodes in unselected paths are
recorded as `skipped` in the run snapshot.

## Dynamic fan-out

Use `map()` when the number of nodes depends on runtime data. Its result keeps
the source order, so it can be passed directly into a fan-in node.

```ts
const companies = node(findRelatedCompanies, { leadId: input.leadId })

const enriched = map(
	companies.items,
	(company) => node(enrichCompany, { companyId: company.id }),
	{ concurrency: 5 },
)

return node(generateReport, { companies: enriched })
```

The callback may define a small per-item flow and must return its final node
output. Without `concurrency`, every ready item runs in parallel.

## Explicit loops

Flows are DAGs by default. Use `loop()` when state must move through explicit,
sequential iterations; each iteration still runs its independent nodes in
parallel. A loop fails after 100 iterations by default, or at `maxIterations`.

```ts
const polling = flows.defineFlow({
	id: 'wait-for-export',
	flow: ({ loop }) =>
		loop({
			initial: { attempts: 0, ready: false },
			while: (state) => !state.ready,
			maxIterations: 12,
			run: ({ state, node }) => node(checkExport, state),
		}),
})
```

The returned node output becomes the next state. `state` and `iteration` are
fully typed inside `run()`, and `map()` is supported within an iteration.

## Runtimes

- [Memory](src/runtimes/memory/README.md) — fast, process-local execution for tests and development.
- [BullMQ](src/runtimes/bullmq/README.md) — Redis-backed producer and worker execution.
- [BullMQ PostgreSQL](src/runtimes/bullmq/postgres/README.md) — BullMQ execution backed by PostgreSQL.

## Lifecycle hooks

Observe every run without coupling workflow code to an observability provider.

```ts
const flows = betterFlows({
	runtime: memory(),
	nodes: { enrichLead },
	hooks: {
		onNodeError: ({ nodeId, error, willRetry }) => {
				logger.error({ nodeId, error, willRetry }, 'Node failed')
			},
		onRunFinish: ({ run }) => metrics.record(run),
	},
})
```

Plugins can contribute these same hooks, plus shared context and public APIs.
