import type { Schema } from './types'
import type { Reference } from './types/internal'

export const nodeBrand = Symbol('better-flows.node')
export const flowBrand = Symbol('better-flows.flow')
export const referenceBrand = Symbol('better-flows.reference')

export type {
	MapStep,
	Plan,
	Reference,
	RuntimeNode,
	Step,
} from './types/internal'

export function createReference(
	nodeId: string,
	path: readonly PropertyKey[] = [],
): Reference {
	const target: Reference = { [referenceBrand]: { nodeId, path } }
	return new Proxy(target, {
		get(value, property) {
			if (property === referenceBrand) return value[referenceBrand]
			if (property === 'then') return undefined
			return createReference(nodeId, [...path, property])
		},
	})
}

export function getReference(value: unknown): Reference | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	return referenceBrand in value ? (value as Reference) : undefined
}

export async function validate(
	schema: Schema | undefined,
	value: unknown,
): Promise<unknown> {
	if (!schema) return value
	const result = await schema['~standard'].validate(value)
	if (!result.issues) return result.value
	throw new TypeError(result.issues.map((issue) => issue.message).join('; '))
}

export function resolve(
	value: unknown,
	outputs: ReadonlyMap<string, unknown>,
): unknown {
	const reference = getReference(value)
	if (reference) {
		let resolved = outputs.get(reference[referenceBrand].nodeId)
		for (const property of reference[referenceBrand].path) {
			if (resolved === null || resolved === undefined) return undefined
			resolved = (resolved as Record<PropertyKey, unknown>)[property]
		}
		return resolved
	}
	if (Array.isArray(value)) return value.map((item) => resolve(item, outputs))
	if (
		typeof value !== 'object' ||
		value === null ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		return value
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, resolve(item, outputs)]),
	)
}

export function dependencies(
	value: unknown,
	result = new Set<string>(),
): Set<string> {
	const reference = getReference(value)
	if (reference) {
		result.add(reference[referenceBrand].nodeId)
		return result
	}
	if (Array.isArray(value)) {
		for (const item of value) dependencies(item, result)
	} else if (
		typeof value === 'object' &&
		value !== null &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	) {
		for (const item of Object.values(value)) dependencies(item, result)
	}
	return result
}

export function duration(value: string | number): number {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0)
		return value
	if (typeof value === 'string') {
		const match = /^(\d+)(ms|s|m|h)$/.exec(value)
		if (match) {
			const amount = Number(match[1])
			const unit = match[2]
			return (
				amount *
				(unit === 'h'
					? 3_600_000
					: unit === 'm'
						? 60_000
						: unit === 's'
							? 1_000
							: 1)
			)
		}
	}
	throw new TypeError(
		`Invalid timeout "${value}". Use milliseconds or values such as "2m".`,
	)
}
