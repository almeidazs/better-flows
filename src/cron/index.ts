import { Cron, type CronOptions } from 'croner'

import { defineTrigger, type Trigger } from '../triggers'
import type { TriggerContext } from '../types'

/** Croner scheduling options plus Better Flows input mapping. */
export interface CronTriggerOptions<TFlowInput, TCronContext = undefined>
	extends CronOptions<TCronContext> {
	/** Stable trigger identifier within its target flow. */
	readonly id?: string
	/** Maps each scheduled occurrence into input for the target flow. */
	readonly input: (
		occurrence: TriggerContext<TCronContext>,
	) => TFlowInput | Promise<TFlowInput>
}

/**
 * Creates an in-process cron trigger backed by Croner.
 *
 * Schedules use UTC unless `timezone` or `utcOffset` is provided. Cron jobs
 * begin only after `flows.triggers.start()` and stop with `flows.triggers.stop()`.
 */
export function cron(pattern: string): Trigger<'cron', undefined, undefined>
/** Creates a cron trigger with typed flow input and Croner scheduling options. */
export function cron<TFlowInput, TCronContext = undefined>(
	pattern: string,
	options: CronTriggerOptions<TFlowInput, TCronContext>,
): Trigger<'cron', TCronContext, TFlowInput>
export function cron<TFlowInput, TCronContext = undefined>(
	pattern: string,
	options?: CronTriggerOptions<TFlowInput, TCronContext>,
): Trigger<'cron', TCronContext, TFlowInput | undefined> {
	const id = options?.id
	const input = options?.input
	const configuredOptions: CronOptions<TCronContext> = options
		? (() => {
				const { id: _id, input: _input, ...schedulerOptions } = options
				return schedulerOptions
			})()
		: {}
	let job: Cron<TCronContext> | undefined
	return defineTrigger({
		type: 'cron',
		...(id ? { id } : {}),
		input: (occurrence) => input?.(occurrence) as TFlowInput | undefined,
		setup: (triggerContext) => {
			const schedulerOptions = {
				...configuredOptions,
				...(configuredOptions.timezone ||
				configuredOptions.utcOffset !== undefined
					? {}
					: { timezone: 'UTC' }),
			}
			job = new Cron(pattern, schedulerOptions, async (_job, cronContext) => {
				const run = await triggerContext.emit(cronContext, {
					metadata: {
						pattern,
						timezone:
							schedulerOptions.timezone ?? schedulerOptions.utcOffset ?? 'UTC',
					},
				})
				await run.wait()
			})
		},
		dispose: () => job?.stop(),
	})
}
