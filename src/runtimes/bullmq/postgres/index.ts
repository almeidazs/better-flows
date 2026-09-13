import { createPostgresBackend, type PostgresConnectionOptions } from 'bullmq'
import { type BullMQRuntime, createBullMQRuntime } from '..'

/** Configuration used to connect the BullMQ runtime to PostgreSQL. */
export interface BullMQPostgresOptions {
	/** A PostgreSQL URL, `pg.Pool` configuration, or an existing `pg.Pool`. */
	readonly connection: PostgresConnectionOptions
	/** Queue namespace. Defaults to `better-flows`. */
	readonly queueName?: string
}

/**
 * Creates a PostgreSQL-backed BullMQ runtime for durable workflow execution.
 *
 * Install `bullmq` and `pg`, and run BullMQ's PostgreSQL migrations before
 * starting workers. Start a worker with `flows.worker()` in a process that
 * imports and registers the same flow definitions.
 */
export function postgres(options: BullMQPostgresOptions): BullMQRuntime {
	return createBullMQRuntime(options, createPostgresBackend as never)
}
