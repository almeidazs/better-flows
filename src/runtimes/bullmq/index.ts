import { type ConnectionOptions, Queue, QueueEvents, Worker } from 'bullmq'

import type {
	Execution,
	FlowProcessor,
	RunSnapshot,
	Runtime,
	WorkerRuntime,
} from '..'

interface JobData {
	readonly flowId: string
	readonly input: unknown
	readonly cancelled?: boolean
}

/** Configuration used to connect the BullMQ runtime to Redis. */
export interface BullMQOptions {
	readonly connection: ConnectionOptions
	readonly queueName?: string
}

class BullMQRuntime implements WorkerRuntime {
	readonly #queue: Queue<JobData, RunSnapshot>
	readonly #options: BullMQOptions

	constructor(options: BullMQOptions) {
		this.#options = options
		this.#queue = new Queue(options.queueName ?? 'better-flows', {
			connection: options.connection,
		})
	}

	async start(execution: Execution): Promise<string> {
		const job = await this.#queue.add(
			execution.plan.id,
			{ flowId: execution.plan.id, input: execution.input },
			{ attempts: 1, jobId: execution.id },
		)
		if (!job.id) throw new Error('BullMQ did not return a job id.')
		return job.id
	}

	async get(id: string): Promise<RunSnapshot | undefined> {
		const job = await this.#queue.getJob(id)
		if (!job) return undefined
		if (job.data.cancelled) return { id, status: 'cancelled', nodes: {} }
		const state = await job.getState()
		const progress =
			typeof job.progress === 'object' && job.progress !== null
				? (job.progress as RunSnapshot)
				: undefined
		if (job.returnvalue) return job.returnvalue
		return (
			progress ?? {
				id,
				status:
					state === 'completed'
						? 'completed'
						: state === 'failed'
							? 'failed'
							: 'running',
				nodes: {},
			}
		)
	}

	async wait(id: string): Promise<RunSnapshot> {
		const job = await this.#queue.getJob(id)
		if (!job) throw new Error(`Run "${id}" was not found.`)
		if (job.data.cancelled) return { id, status: 'cancelled', nodes: {} }
		const events = new QueueEvents(this.#options.queueName ?? 'better-flows', {
			connection: this.#options.connection,
		})
		try {
			await job.waitUntilFinished(events)
		} catch {
			const result = await this.get(id)
			if (result) return result
			throw new Error(`Run "${id}" was not found.`)
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
		const worker = new Worker<JobData, RunSnapshot>(
			this.#options.queueName ?? 'better-flows',
			async (job) => {
				if (!job.id) throw new Error('BullMQ job is missing an id.')
				const jobId = job.id
				if (job.data.cancelled)
					return { id: jobId, status: 'cancelled', nodes: {} }
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
					)
				} finally {
					clearInterval(cancellationPoll)
				}
			},
			{ connection: this.#options.connection },
		)
		return worker
	}
}

/**
 * Creates a BullMQ-backed runtime for durable queued workflow execution.
 *
 * Start a worker with `flows.worker()` in a process that imports and registers
 * the same flow definitions. Call `close()` when the producer is shut down.
 */
export function bullmq(options: BullMQOptions): Runtime & WorkerRuntime {
	return new BullMQRuntime(options)
}
