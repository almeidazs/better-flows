import type { referenceBrand } from '../internal'
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
}
export interface Plan {
	readonly id: string
	readonly input?: Schema
	readonly output?: Schema
	readonly steps: readonly Step[]
	readonly result: unknown
}
