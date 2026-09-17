import {
	createReference,
	dependencies,
	flowBrand,
	getReference,
	type Plan,
	type Reference,
	type RuntimeNode,
	type Step,
} from '../internal'
import type { AnyNode, NodeInput, NodeOutput } from '../nodes'
import type { RunSnapshot } from '../runtimes'
import type { Schema, Trigger } from '../types'

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
	/** Expands a typed mini-flow once for every item resolved at runtime. */
	map<TItem, TResult>(
		items: readonly TItem[],
		callback: (item: TItem, index: number) => TResult,
		options?: { readonly concurrency?: number },
	): TResult[]
	/** Repeats a typed state transition until its runtime condition becomes false. */
	loop<TState>(options: {
		/** State used before the first iteration. */
		readonly initial: TState
		/** Determines whether another iteration should execute. */
		readonly while: (state: TState) => boolean
		/** Maximum iterations allowed before the run fails. Defaults to 100. */
		readonly maxIterations?: number
		/** Declares one iteration and returns the next state from a node output. */
		readonly run: (
			builder: FlowBuilder & {
				readonly state: TState
				readonly iteration: number
			},
		) => TState
	}): TState
}

/** Declarative definition of a typed workflow. */
export interface FlowDefinition<TInput, TOutput> {
	readonly id: string
	readonly input?: Schema<unknown, TInput>
	readonly output?: Schema<unknown, TOutput>
	/** Triggers that can start this flow once `flows.triggers.start()` is called. */
	readonly triggers?: readonly Trigger<string, never, TInput>[]
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
	/** Trigger occurrence that started this run, when applicable. */
	trigger?: RunSnapshot['trigger']
	/** Waits for completion and returns the terminal run snapshot. */
	wait(): Promise<RunSnapshot & { readonly output?: TOutput }>
	/** Requests cooperative cancellation for this run. */
	cancel(): Promise<void>
}

export function compileFlow<TInput, TOutput>(
	definition: FlowDefinition<TInput, TOutput>,
): CompiledFlow<TInput, TOutput> {
	const steps: Step[] = []
	const maps: {
		id: string
		items: unknown
		steps: readonly Step[]
		result: unknown
		concurrency?: number
	}[] = []
	const loops: {
		id: string
		initial: unknown
		while: (state: unknown) => boolean
		conditions: Step['conditions']
		steps: readonly Step[]
		maps: readonly {
			id: string
			items: unknown
			steps: readonly Step[]
			result: unknown
			concurrency?: number
		}[]
		result: unknown
		maxIterations: number
	}[] = []
	let activeSteps = steps
	let activeMaps = maps
	let mapDepth = 0
	let loopDepth = 0
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
				(node as { readonly id?: string }).id ??
				`node-${activeSteps.length + 1}`
			const occurrence = activeSteps.filter(
				(step) => step.id === baseId || step.id.startsWith(`${baseId}#`),
			).length
			const id = occurrence === 0 ? baseId : `${baseId}#${occurrence + 1}`
			activeSteps.push({
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
		map(items, callback, options) {
			if (mapDepth > 0)
				throw new TypeError('map() cannot be nested inside another map().')
			if (!getReference(items))
				throw new TypeError(
					'map() requires a flow input or node output reference.',
				)
			if (
				options?.concurrency !== undefined &&
				(!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
			)
				throw new TypeError('map().concurrency must be a positive integer.')
			const template: Step[] = []
			const parentSteps = activeSteps
			activeSteps = template
			mapDepth++
			let result: unknown
			try {
				result = callback(
					createReference('$map:item') as never,
					createReference('$map:index') as never,
				)
			} finally {
				mapDepth--
				activeSteps = parentSteps
			}
			if (!getReference(result))
				throw new TypeError(
					'map() callback must return a node output reference.',
				)
			const id = `map-${activeMaps.length + 1}`
			activeMaps.push({
				id,
				items,
				steps: template,
				result,
				...(options?.concurrency === undefined
					? {}
					: { concurrency: options.concurrency }),
			})
			return createReference(id) as never
		},
		loop(options) {
			if (mapDepth > 0)
				throw new TypeError('loop() cannot be declared inside map().')
			if (loopDepth > 0)
				throw new TypeError('loop() cannot be nested inside another loop().')
			const maxIterations = options.maxIterations ?? 100
			if (!Number.isSafeInteger(maxIterations) || maxIterations < 1)
				throw new TypeError('loop().maxIterations must be a positive integer.')
			const template: Step[] = []
			const loopMaps: typeof maps = []
			const parentSteps = activeSteps
			const parentMaps = activeMaps
			activeSteps = template
			activeMaps = loopMaps
			loopDepth++
			let result: unknown
			try {
				result = options.run({
					...builder,
					state: createReference('$loop:state') as never,
					iteration: createReference('$loop:iteration') as never,
				})
			} finally {
				loopDepth--
				activeSteps = parentSteps
				activeMaps = parentMaps
			}
			if (!getReference(result))
				throw new TypeError('loop().run() must return a node output reference.')
			const [resultNodeId] = dependencies(result)
			if (
				!resultNodeId ||
				(!template.some((step) => step.id === resultNodeId) &&
					!loopMaps.some((map) => map.id === resultNodeId))
			)
				throw new TypeError(
					'loop().run() must return an output declared inside the loop.',
				)
			const id = `loop-${loops.length + 1}`
			loops.push({
				id,
				initial: options.initial,
				while: options.while as (state: unknown) => boolean,
				conditions,
				steps: template,
				maps: loopMaps,
				result,
				maxIterations,
			})
			return createReference(id) as never
		},
	}
	const result = definition.flow(builder)
	const validateSteps = (
		label: string,
		current: readonly Step[],
		allowed: ReadonlySet<string>,
	) => {
		const ids = new Set(current.map((step) => step.id))
		const visiting = new Set<string>()
		const visited = new Set<string>()
		const visit = (id: string, path: string[]): void => {
			if (visiting.has(id))
				throw new Error(
					`Flow graph contains a cycle in ${label}: ${[...path, id].join(' -> ')}.`,
				)
			if (visited.has(id)) return
			visiting.add(id)
			const step = current.find((candidate) => candidate.id === id)
			if (step) {
				const references = new Set([
					...dependencies(step.input),
					...step.conditions.flatMap((condition) => [
						...dependencies(condition.value),
					]),
				])
				for (const reference of references) {
					if (ids.has(reference)) visit(reference, [...path, id])
					else if (!allowed.has(reference))
						throw new Error(
							`Flow graph references unknown node "${reference}" in ${label}.`,
						)
				}
			}
			visiting.delete(id)
			visited.add(id)
		}
		for (const id of ids) visit(id, [])
	}
	const mainOutputs = new Set([
		'$input',
		...steps.map((step) => step.id),
		...maps.map((map) => map.id),
		...loops.map((loop) => loop.id),
	])
	const stepReferences = (current: readonly Step[]) =>
		current.flatMap((step) => [
			...dependencies(step.input),
			...step.conditions.flatMap((condition) => [
				...dependencies(condition.value),
			]),
		])
	const graph = new Map<string, Set<string>>(
		steps.map((step) => [step.id, new Set(stepReferences([step]))]),
	)
	for (const map of maps) {
		const local = new Set([
			...map.steps.map((step) => step.id),
			'$map:item',
			'$map:index',
		])
		graph.set(
			map.id,
			new Set(
				[...dependencies(map.items), ...stepReferences(map.steps)].filter(
					(reference) => !local.has(reference),
				),
			),
		)
	}
	for (const loop of loops) {
		const local = new Set([
			...loop.steps.map((step) => step.id),
			...loop.maps.map((map) => map.id),
			'$loop:state',
			'$loop:iteration',
			'$map:item',
			'$map:index',
		])
		graph.set(
			loop.id,
			new Set(
				[
					...dependencies(loop.initial),
					...loop.conditions.flatMap((condition) => [
						...dependencies(condition.value),
					]),
					...stepReferences(loop.steps),
					...loop.maps.flatMap((map) => [
						...dependencies(map.items),
						...stepReferences(map.steps),
					]),
				].filter((reference) => !local.has(reference)),
			),
		)
	}
	const visiting = new Set<string>()
	const visited = new Set<string>()
	const visitGraph = (id: string, path: string[]): void => {
		if (visiting.has(id))
			throw new Error(
				`Flow graph contains a cycle: ${[...path, id].join(' -> ')}.`,
			)
		if (visited.has(id)) return
		visiting.add(id)
		for (const dependency of graph.get(id) ?? [])
			if (graph.has(dependency)) visitGraph(dependency, [...path, id])
		visiting.delete(id)
		visited.add(id)
	}
	for (const id of graph.keys()) visitGraph(id, [])
	validateSteps(
		'flow',
		steps,
		new Set([
			'$input',
			...maps.map((map) => map.id),
			...loops.map((loop) => loop.id),
		]),
	)
	for (const map of maps) {
		for (const reference of dependencies(map.items))
			if (!mainOutputs.has(reference))
				throw new Error(
					`Flow graph references unknown node "${reference}" in map "${map.id}".`,
				)
		validateSteps(
			`map "${map.id}"`,
			map.steps,
			new Set([...mainOutputs, '$map:item', '$map:index']),
		)
	}
	for (const loop of loops) {
		for (const reference of dependencies(loop.initial))
			if (!mainOutputs.has(reference))
				throw new Error(
					`Flow graph references unknown node "${reference}" in loop "${loop.id}".`,
				)
		const loopOutputs = new Set([
			...mainOutputs,
			...loop.maps.map((map) => map.id),
			'$loop:state',
			'$loop:iteration',
		])
		validateSteps(`loop "${loop.id}"`, loop.steps, loopOutputs)
		for (const map of loop.maps) {
			for (const reference of dependencies(map.items))
				if (
					!loopOutputs.has(reference) &&
					!loop.steps.some((step) => step.id === reference)
				)
					throw new Error(
						`Flow graph references unknown node "${reference}" in map "${map.id}" in loop "${loop.id}".`,
					)
			validateSteps(
				`map "${map.id}" in loop "${loop.id}"`,
				map.steps,
				new Set([
					...loopOutputs,
					...loop.steps.map((step) => step.id),
					'$map:item',
					'$map:index',
				]),
			)
		}
	}
	for (const reference of dependencies(result))
		if (!mainOutputs.has(reference))
			throw new Error(
				`Flow graph references unknown node "${reference}" in flow output.`,
			)
	const plan: Plan = {
		id: definition.id,
		...(definition.input ? { input: definition.input } : {}),
		...(definition.output ? { output: definition.output } : {}),
		steps,
		maps,
		loops,
		result,
	}
	return {
		...definition,
		[flowBrand]: true,
		plan,
	}
}
