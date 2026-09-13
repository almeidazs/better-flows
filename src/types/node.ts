import type { nodeBrand } from '../internal'
import type { Schema } from './schema'

/** Execution metadata and application services available to a node. */
export type NodeContext<TContext extends object = object> = TContext & {
	readonly flowId: string
	readonly nodeId: string
	readonly runId: string
	readonly signal: AbortSignal
}

/** Configuration for a reusable workflow node. */
export interface NodeDefinition<
	TInput = unknown,
	TOutput = unknown,
	TContext extends object = object,
> {
	readonly id?: string
	readonly input?: Schema<unknown, TInput>
	readonly output?: Schema<unknown, TOutput>
	readonly retry?:
		| false
		| { readonly attempts?: number; readonly backoff?: 'exponential' | 'fixed' }
	readonly timeout?: string | number
	/** Executes the node with validated input and run-scoped context. */
	readonly run: (arguments_: {
		readonly input: TInput
		readonly ctx: NodeContext<TContext>
	}) => TOutput | Promise<TOutput>
}

/** Extracts the accepted input type from a node. */
export type NodeInput<TNode> = TNode extends {
	readonly run: (arguments_: infer TArguments) => unknown
}
	? TArguments extends { readonly input: infer TInput }
		? TInput
		: never
	: never

/** Extracts the validated output type from a node. */
export type NodeOutput<TNode> = TNode extends {
	readonly output: Schema<unknown, infer TOutput>
}
	? TOutput
	: TNode extends { readonly run: (...arguments_: never[]) => infer TOutput }
		? Awaited<TOutput>
		: never

/** A branded executable node created by {@link defineNode}. */
export type Node<
	TInput = unknown,
	TOutput = unknown,
	TContext extends object = object,
> = NodeDefinition<TInput, TOutput, TContext> & { readonly [nodeBrand]: true }

/** The broad node constraint used by registries and flow builders. */
export type AnyNode = { readonly [nodeBrand]: true }
