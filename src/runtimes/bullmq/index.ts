import {
	type BackendFactory,
	type ConnectionOptions,
	type IQueueBackend,
	type Job,
	Queue,
	QueueEvents,
	Worker,
} from 'bullmq'
import type { TriggerOccurrence } from '../../types'
import type {
	Execution,
	FlowProcessor,
	RunSnapshot,
	Runtime,
	WorkerRuntime,
} from '..'

type StoredTrigger = Omit<TriggerOccurrence, 'occurredAt'> & {
	readonly occurredAt: string
}

interface JobData {
	readonly flowId: string
	readonly input: unknown
	readonly cancelled?: boolean
	readonly trigger?: StoredTrigger
}

function serializeTrigger(
	trigger: TriggerOccurrence | undefined,
): StoredTrigger | undefined {
	return trigger && { ...trigger, occurredAt: trigger.occurredAt.toISOString() }
}

function restoreTrigger(
	trigger: StoredTrigger | undefined,
): TriggerOccurrence | undefined {
	return trigger && { ...trigger, occurredAt: new Date(trigger.occurredAt) }
}

function restoreSnapshot(
	snapshot: RunSnapshot,
	trigger?: StoredTrigger,
): RunSnapshot {
	const occurrence = snapshot.trigger ?? restoreTrigger(trigger)
	if (!occurrence) return snapshot
	return {
		...snapshot,
		trigger: {
			...occurrence,
			occurredAt: new Date(
				occurrence.occurredAt instanceof Date
					? occurrence.occurredAt.getTime()
					: occurrence.occurredAt,
			),
		},
	}
}

/** Configuration used to connect the BullMQ runtime to Redis. */
export interface BullMQOptions {
	/** Redis connection settings accepted by BullMQ. */
	readonly connection: ConnectionOptions
	/** Queue namespace. Defaults to `better-flows`. */
	readonly queueName?: string
}

interface SharedBullMQOptions {
	readonly connection: unknown
	readonly queueName?: string
}

/** A BullMQ runtime with an explicit resource cleanup method. */
export type BullMQRuntime = Runtime &
	WorkerRuntime & {
		/** Closes the underlying BullMQ queue connection. */
		close(): Promise<void>
	}

class BullMQAdapter implements WorkerRuntime {
	readonly #queue: Queue<JobData, RunSnapshot>
	readonly #options: SharedBullMQOptions
	readonly #backendFactory: BackendFactory<IQueueBackend> | undefined

	constructor(
		options: SharedBullMQOptions,
		backendFactory?: BackendFactory<IQueueBackend>,
	) {
		this.#options = options
		this.#backendFactory = backendFactory
		this.#queue = backendFactory
			? new Queue(
					options.queueName ?? 'better-flows',
					{ connection: options.connection } as never,
					backendFactory as never,
				)
			: new Queue(options.queueName ?? 'better-flows', {
					connection: options.connection,
				} as never)
	}

	async start(execution: Execution): Promise<string> {
		const trigger = serializeTrigger(execution.trigger)
		const job = await this.#queue.add(
			execution.plan.id,
			{
				flowId: execution.plan.id,
				input: execution.input,
				...(trigger ? { trigger } : {}),
			},
			{ attempts: 1, jobId: execution.id },
		)
		if (!job.id) throw new Error('BullMQ did not return a job id.')
		return job.id
	}

	async get(id: string): Promise<RunSnapshot | undefined> {
		const job = await this.#queue.getJob(id)
		if (!job) return undefined
		if (job.data.cancelled)
			return restoreSnapshot(
				{ id, status: 'cancelled', nodes: {} },
				job.data.trigger,
			)
		const state = await job.getState()
		const progress =
			typeof job.progress === 'object' && job.progress !== null
				? (job.progress as RunSnapshot)
				: undefined
		if (job.returnvalue)
			return restoreSnapshot(job.returnvalue, job.data.trigger)
		return progress
			? restoreSnapshot(progress, job.data.trigger)
			: restoreSnapshot(
					{
						id,
						status:
							state === 'completed'
								? 'completed'
								: state === 'failed'
									? 'failed'
									: 'running',
						nodes: {},
					},
					job.data.trigger,
				)
	}

	async wait(id: string): Promise<RunSnapshot> {
		const job = await this.#queue.getJob(id)
		if (!job) throw new Error(`Run "${id}" was not found.`)
		if (job.data.cancelled)
			return restoreSnapshot(
				{ id, status: 'cancelled', nodes: {} },
				job.data.trigger,
			)
		const events = this.#backendFactory
			? new QueueEvents(
					this.#options.queueName ?? 'better-flows',
					{ connection: this.#options.connection } as never,
					this.#backendFactory as never,
				)
			: new QueueEvents(this.#options.queueName ?? 'better-flows', {
					connection: this.#options.connection,
				} as never)
		try {
			await job.waitUntilFinished(events)
		} catch (error) {
			const result = await this.get(id)
			if (result && result.status !== 'running') return result
			throw error
		} finally {
			await events.close()
		}
		const result = await this.get(id)
		if (!result) throw new Error(`Run "${id}" was not found.`)
		return result
	}

	async cancel(id: string): Promise<void> {
		const job = await this.#queue.getJob(id)
		if (!job) return
		await job.updateData({ ...job.data, cancelled: true })
	}

	async close(): Promise<void> {
		await this.#queue.close()
	}

	worker(processor: FlowProcessor): { close(): Promise<void> } {
		const runJob = async (job: Job<JobData, RunSnapshot>) => {
			if (!job.id) throw new Error('BullMQ job is missing an id.')
			const jobId = job.id
			if (job.data.cancelled)
				return restoreSnapshot(
					{ id: jobId, status: 'cancelled', nodes: {} },
					job.data.trigger,
				)
			const controller = new AbortController()
			const cancellationPoll = setInterval(() => {
				void this.#queue
					.getJob(jobId)
					.then((current) => {
						if (current?.data.cancelled) controller.abort()
					})
					.catch(() => controller.abort())
			}, 100)
			try {
				return await processor(
					job.data.flowId,
					job.data.input,
					jobId,
					(result) => job.updateProgress(result),
					controller.signal,
					restoreTrigger(job.data.trigger),
				)
			} finally {
				clearInterval(cancellationPoll)
			}
		}
		const worker = this.#backendFactory
			? new Worker<JobData, RunSnapshot>(
					this.#options.queueName ?? 'better-flows',
					runJob,
					{ connection: this.#options.connection } as never,
					this.#backendFactory as never,
				)
			: new Worker<JobData, RunSnapshot>(
					this.#options.queueName ?? 'better-flows',
					runJob,
					{ connection: this.#options.connection } as never,
				)
		return worker
	}
}

/** @internal Creates a runtime with a selected BullMQ storage backend. */
export function createBullMQRuntime(
	options: SharedBullMQOptions,
	backendFactory?: BackendFactory<IQueueBackend>,
): BullMQRuntime {
	return new BullMQAdapter(options, backendFactory)
}

/**
 * Creates a Redis-backed BullMQ runtime for durable queued workflow execution.
 *
 * Start a worker with `flows.worker()` in a process that imports and registers
 * the same flow definitions. Call `close()` when the producer is shut down.
 */
export function bullmq(options: BullMQOptions): BullMQRuntime {
	return createBullMQRuntime(options)
}
