import {
	createReference,
	flowBrand,
	getReference,
	type Plan,
	type Reference,
	type RuntimeNode,
} from '../internal'
import type { AnyNode, NodeInput, NodeOutput } from '../nodes'
import type { RunSnapshot } from '../runtimes'
import type { Schema } from '../types'

/** Builder supplied while a flow is being compiled into a dependency graph. */
export interface FlowBuilder {
	/** Declares a node invocation and returns a typed reference to its output. */
	node<TNode extends AnyNode>(
		node: TNode,
		input: NodeInput<TNode>,
	): NodeOutput<TNode>
	/** Groups declarations whose dependencies may run concurrently. */
	parallel<TResult>(callback: () => TResult): TResult
	/** Declares conditional paths selected by a string node or input reference. */
	branch<TValue extends string>(
		value: TValue,
		cases: Partial<Record<TValue | 'default', () => void>>,
	): void
	/** Declares ordered predicate-based paths for a node or input reference. */
	branch<TValue, TCase extends string>(
		value: TValue,
		predicates: Record<
			TCase,
			(arguments_: { readonly value: TValue }) => boolean
		>,
		cases: Partial<Record<TCase, () => void>>,
	): void
	/** Declares literal string paths for a node or input reference. */
	switch<TValue extends string>(
		value: TValue,
		cases: Partial<Record<TValue | 'default', () => void>>,
	): void
	/** Declares a path that runs only when a boolean reference is true. */
	when(value: boolean, callback: () => void): void
	/** Declares a path selected by a runtime predicate. */
	when<TValue>(
		value: TValue,
		predicate: (arguments_: { readonly value: TValue }) => boolean,
		callback: () => void,
	): void
}

/** Declarative definition of a typed workflow. */
export interface FlowDefinition<TInput, TOutput> {
	readonly id: string
	readonly input?: Schema<unknown, TInput>
	readonly output?: Schema<unknown, TOutput>
	readonly flow: (builder: FlowBuilder & { readonly input: TInput }) => TOutput
}

/** A compiled workflow that can be started directly. */
export interface Flow<TInput, TOutput> extends FlowDefinition<TInput, TOutput> {
	readonly [flowBrand]: true
	/** Starts a new run through the flow's configured runtime. */
	run(input: TInput): Promise<RunHandle<TOutput>>
	readonly plan: Plan
}

/** Internal compiled form of a flow before its runtime-bound `run` method is attached. */
export type CompiledFlow<TInput, TOutput> = Omit<Flow<TInput, TOutput>, 'run'>

/** Handle for observing, awaiting, or cancelling a workflow run. */
export interface RunHandle<TOutput> {
	id: string
	status: RunSnapshot['status']
	output?: TOutput
	nodes: RunSnapshot['nodes']
	/** Waits for completion and returns the terminal run snapshot. */
	wait(): Promise<RunSnapshot & { readonly output?: TOutput }>
	/** Requests cooperative cancellation for this run. */
	cancel(): Promise<void>
}

export function compileFlow<TInput, TOutput>(
	definition: FlowDefinition<TInput, TOutput>,
): CompiledFlow<TInput, TOutput> {
	const steps: {
		id: string
		node: RuntimeNode
		input: unknown
		conditions: readonly {
			value: Reference
			expected: unknown
			otherwise?: readonly PropertyKey[]
		}[]
	}[] = []
	type Condition = {
		value: Reference
		expected: unknown
		otherwise?: readonly PropertyKey[]
		predicate?: (value: unknown) => boolean
		previousPredicates?: readonly ((value: unknown) => boolean)[]
	}
	type Cases = Record<string, (() => void) | undefined>
	let conditions: readonly Condition[] = []
	const builder: FlowBuilder & { input: TInput } = {
		input: createReference('$input') as TInput,
		node(node, input) {
			const baseId =
				(node as { readonly id?: string }).id ?? `node-${steps.length + 1}`
			const occurrence = steps.filter(
				(step) => step.id === baseId || step.id.startsWith(`${baseId}#`),
			).length
			const id = occurrence === 0 ? baseId : `${baseId}#${occurrence + 1}`
			steps.push({
				id,
				node: node as unknown as RuntimeNode,
				input,
				conditions,
			})
			return createReference(id) as NodeOutput<typeof node>
		},
		parallel(callback) {
			return callback()
		},
		branch(
			value: unknown,
			predicatesOrCases:
				| Cases
				| Record<string, (arguments_: { readonly value: unknown }) => boolean>,
			maybeCases?: Cases,
		) {
			const reference = getReference(value)
			if (!reference)
				throw new TypeError(
					'branch() requires a node output or flow input reference.',
				)
			const parent = conditions
			const cases = (maybeCases ?? predicatesOrCases) as Cases
			if (maybeCases) {
				const predicates = predicatesOrCases as Record<
					string,
					(arguments_: { readonly value: unknown }) => boolean
				>
				const previous: ((value: unknown) => boolean)[] = []
				for (const [name, callback] of Object.entries(cases)) {
					const predicate = predicates[name]
					if (!callback || !predicate) continue
					conditions = [
						...parent,
						{
							value: reference,
							expected: undefined,
							predicate: (current) => predicate({ value: current }),
							previousPredicates: [...previous],
						},
					]
					callback()
					previous.push((current) => predicate({ value: current }))
				}
				conditions = parent
				return
			}
			const expectedValues = Object.keys(cases).filter(
				(key) => key !== 'default',
			)
			for (const [expected, callback] of Object.entries(cases)) {
				if (!callback) continue
				conditions = [
					...parent,
					expected === 'default'
						? { value: reference, expected, otherwise: expectedValues }
						: { value: reference, expected },
				]
				callback()
			}
			conditions = parent
		},
		switch(value, cases) {
			builder.branch(value, cases)
		},
		when(
			value: unknown,
			predicateOrCallback:
				| (() => void)
				| ((arguments_: { readonly value: unknown }) => boolean),
			maybeCallback?: () => void,
		) {
			const reference = getReference(value)
			if (!reference)
				throw new TypeError(
					'when() requires a node output or flow input reference.',
				)
			const parent = conditions
			const predicate = maybeCallback
				? (predicateOrCallback as (arguments_: {
						readonly value: unknown
					}) => boolean)
				: undefined
			const callback = (maybeCallback ?? predicateOrCallback) as () => void
			conditions = [
				...parent,
				predicate
					? {
							value: reference,
							expected: undefined,
							predicate: (current) => predicate({ value: current }),
						}
					: { value: reference, expected: true },
			]
			callback()
			conditions = parent
		},
	}
	const result = definition.flow(builder)
	const plan: Plan = {
		id: definition.id,
		...(definition.input ? { input: definition.input } : {}),
		...(definition.output ? { output: definition.output } : {}),
		steps,
		result,
	}
	return {
		...definition,
		[flowBrand]: true,
		plan,
	}
}
