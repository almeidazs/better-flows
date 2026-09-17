import type { Execution, RunSnapshot, Runtime } from '..'

class MemoryRuntime implements Runtime {
	readonly #runs = new Map<string, RunSnapshot>()
	readonly #waiters = new Map<string, Promise<RunSnapshot>>()
	readonly #controllers = new Map<string, AbortController>()

	async start(execution: Execution): Promise<string> {
		const id = execution.id
		const controller = new AbortController()
		this.#controllers.set(id, controller)
		this.#runs.set(id, {
			id,
			status: 'running',
			...(execution.trigger ? { trigger: execution.trigger } : {}),
			nodes: Object.fromEntries(
				execution.plan.steps.map((step) => [
					step.id,
					{ status: 'pending', attempts: 0 },
				]),
			),
		})
		const run = execution.execute(async (result) => {
			this.#runs.set(id, result)
		}, controller.signal)
		this.#waiters.set(id, run)
		return id
	}

	async get(id: string): Promise<RunSnapshot | undefined> {
		return this.#runs.get(id)
	}
	async wait(id: string): Promise<RunSnapshot> {
		const run = this.#waiters.get(id)
		if (!run) throw new Error(`Run "${id}" was not found.`)
		return run
	}
	async cancel(id: string): Promise<void> {
		this.#controllers.get(id)?.abort()
	}
}

/**
 * Creates an in-memory runtime for local development and tests.
 *
 * Run state is lost when the process exits and is not shared between processes.
 */
export function memory(): Runtime {
	return new MemoryRuntime()
}
