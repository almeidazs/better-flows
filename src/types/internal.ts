import type { referenceBrand } from '../internal'
import type {
	NodeCancelEvent,
	NodeCompleteEvent,
	NodeErrorEvent,
	NodeFailEvent,
	NodeFinishEvent,
	NodeRetryEvent,
	NodeSkipEvent,
	NodeStartEvent,
} from './hooks'
import type { RunSnapshot } from './runtime'
import type { Schema } from './schema'

export interface Reference {
	readonly [referenceBrand]: {
		readonly nodeId: string
		readonly path: readonly PropertyKey[]
	}
}

export interface RuntimeNode {
	readonly id?: string
	readonly input?: Schema
	readonly output?: Schema
	readonly retry?:
		| false
		| { readonly attempts?: number; readonly backoff?: 'exponential' | 'fixed' }
	readonly timeout?: string | number
	readonly run: (arguments_: {
		readonly input: unknown
		readonly ctx: Record<string, unknown> & {
			readonly flowId: string
			readonly nodeId: string
			readonly runId: string
			readonly signal: AbortSignal
		}
	}) => unknown | Promise<unknown>
}

export interface Step {
	readonly id: string
	readonly node: RuntimeNode
	readonly input: unknown
	readonly conditions: readonly {
		readonly value: Reference
		readonly expected: unknown
		readonly otherwise?: readonly PropertyKey[]
		readonly predicate?: (value: unknown) => boolean
		readonly previousPredicates?: readonly ((value: unknown) => boolean)[]
	}[]
	readonly map?: { readonly id: string; readonly concurrency?: number }
	readonly internal?: boolean
}

/** Internal callbacks emitted by the execution engine at node state transitions. */
export interface EngineHooks {
	readonly onNodeStart?: (
		event: NodeStartEvent<Record<string, unknown>>,
	) => void | Promise<void>
	readonly onNodeComplete?: (
		event: NodeCompleteEvent<Record<string, unknown>>,
	) => void | Promise<void>
	readonly onNodeError?: (
		event: NodeErrorEvent<Record<string, unknown>>,
	) => void | Promise<void>
	readonly onNodeRetry?: (
		event: NodeRetryEvent<Record<string, unknown>>,
	) => void | Promise<void>
	readonly onNodeFail?: (
		event: NodeFailEvent<Record<string, unknown>>,
	) => void | Promise<void>
	readonly onNodeSkip?: (
		event: NodeSkipEvent<Record<string, unknown>>,
	) => void | Promise<void>
	readonly onNodeCancel?: (
		event: NodeCancelEvent<Record<string, unknown>>,
	) => void | Promise<void>
	readonly onNodeFinish?: (
		event: NodeFinishEvent<Record<string, unknown>>,
	) => void | Promise<void>
	readonly onRunFail?: (
		run: RunSnapshot,
		error: unknown,
	) => void | Promise<void>
}

export interface MapStep {
	readonly id: string
	readonly items: unknown
	readonly steps: readonly Step[]
	readonly result: unknown
	readonly concurrency?: number
}
export interface Plan {
	readonly id: string
	readonly input?: Schema
	readonly output?: Schema
	readonly steps: readonly Step[]
	readonly maps: readonly MapStep[]
	readonly result: unknown
}
