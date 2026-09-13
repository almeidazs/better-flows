import type { StandardSchemaV1 } from '@standard-schema/spec'

/** A Standard Schema V1 validator accepted by nodes and flows. */
export type Schema<TInput = unknown, TOutput = TInput> = StandardSchemaV1<
	TInput,
	TOutput
>

/** Extracts the input type accepted by a Standard Schema validator. */
export type InferSchemaInput<TSchema> =
	TSchema extends Schema<infer TInput, unknown> ? TInput : unknown

/** Extracts the output type produced by a Standard Schema validator. */
export type InferSchemaOutput<TSchema> =
	TSchema extends Schema<unknown, infer TOutput> ? TOutput : unknown
