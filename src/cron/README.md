# Cron trigger

`cron()` schedules a Better Flows run inside the current Node.js process. It
uses [Croner](https://github.com/Hexagon/croner), a lightweight TypeScript cron
scheduler with no dependencies.

```ts
import { cron } from 'better-flows/cron'

const report = flows.defineFlow({
	id: 'daily-report',
	triggers: [
		cron('0 9 * * *', {
			timezone: 'America/Sao_Paulo',
			input: () => ({ source: 'daily' as const }),
		}),
	],
	flow: ({ input, node }) => node(generateReport, input),
})

await flows.triggers.start()
```

Schedules use UTC unless `timezone` or `utcOffset` is supplied. The second
argument accepts every Croner option directly: `name`, `paused`, `kill`,
`catch`, `unref`, `maxRuns`, `interval`, `protect`, `startAt`, `stopAt`,
`timezone`, `utcOffset`, `domAndDow`, `dayOffset`, `legacyMode`, `mode`,
`context`, `alternativeWeekdays`, and `sloppyRanges`. `id` identifies the
trigger within the flow; `input` maps each tick to the flow input. When
Croner's `context` option is present, it is available as `occurrence.payload`
inside `input`.

Call `await flows.triggers.stop()` during graceful shutdown. Run the scheduler
in exactly one process or replica for a given flow. For horizontally scaled
applications, dedicate one scheduler process or use a distributed lock before
starting triggers.
