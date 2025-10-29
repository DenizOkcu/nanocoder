import {z} from 'zod';
import type {ToolParameterSchema, Tool} from '@/types/index';

/**
 * Converts a JSON Schema property to a Zod schema
 */
function jsonSchemaPropertyToZod(schema: ToolParameterSchema): z.ZodTypeAny {
	const {type, description} = schema;

	// Handle basic types
	switch (type) {
		case 'string': {
			let zodSchema: z.ZodString = z.string();
			if (description) {
				zodSchema = zodSchema.describe(description);
			}
			// Handle enums
			if (schema.enum && Array.isArray(schema.enum)) {
				const enumValues = schema.enum as [string, ...string[]];
				return z.enum(enumValues).describe(description || '');
			}
			return zodSchema;
		}

		case 'number':
		case 'integer': {
			let zodSchema: z.ZodNumber = z.number();
			if (description) {
				zodSchema = zodSchema.describe(description);
			}
			// Handle min/max
			if (typeof schema.minimum === 'number') {
				zodSchema = zodSchema.min(schema.minimum);
			}
			if (typeof schema.maximum === 'number') {
				zodSchema = zodSchema.max(schema.maximum);
			}
			// Handle integer constraint
			if (type === 'integer') {
				zodSchema = zodSchema.int();
			}
			return zodSchema;
		}

		case 'boolean': {
			let zodSchema: z.ZodBoolean = z.boolean();
			if (description) {
				zodSchema = zodSchema.describe(description);
			}
			return zodSchema;
		}

		case 'array': {
			// Handle array items
			let itemSchema: z.ZodTypeAny = z.any();
			if (schema.items && typeof schema.items === 'object') {
				itemSchema = jsonSchemaPropertyToZod(
					schema.items as ToolParameterSchema,
				);
			}
			let zodSchema = z.array(itemSchema);
			if (description) {
				zodSchema = zodSchema.describe(description);
			}
			// Handle min/max items
			if (typeof schema.minItems === 'number') {
				zodSchema = zodSchema.min(schema.minItems);
			}
			if (typeof schema.maxItems === 'number') {
				zodSchema = zodSchema.max(schema.maxItems);
			}
			return zodSchema;
		}

		case 'object': {
			// Handle nested object properties
			if (schema.properties && typeof schema.properties === 'object') {
				const shape: Record<string, z.ZodTypeAny> = {};
				const properties = schema.properties as Record<
					string,
					ToolParameterSchema
				>;

				for (const [key, propSchema] of Object.entries(properties)) {
					shape[key] = jsonSchemaPropertyToZod(propSchema);
				}

				let zodSchema = z.object(shape);

				// Handle additionalProperties
				if (schema.additionalProperties !== false) {
					zodSchema = zodSchema.passthrough() as unknown as typeof zodSchema;
				}

				if (description) {
					zodSchema = zodSchema.describe(description);
				}

				return zodSchema;
			}

			// Generic object with passthrough
			let zodSchema = z.object({}).passthrough();
			if (description) {
				zodSchema = zodSchema.describe(description);
			}
			return zodSchema;
		}

		case 'null': {
			return z.null().describe(description || '');
		}

		default: {
			// If type is not specified or unknown, use z.any()
			return z.any().describe(description || '');
		}
	}
}

/**
 * Converts a Tool's JSON Schema parameters to a Zod schema
 * Handles the root object and required fields
 */
function toolParametersToZod(
	parameters: Tool['function']['parameters'],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
	const shape: Record<string, z.ZodTypeAny> = {};
	const required = parameters.required || [];

	// Convert each property
	for (const [key, propSchema] of Object.entries(parameters.properties)) {
		let zodSchema = jsonSchemaPropertyToZod(propSchema);

		// Mark as optional if not in required array
		if (!required.includes(key)) {
			zodSchema = zodSchema.optional();
		}

		shape[key] = zodSchema;
	}

	// Create the final object schema
	return z.object(shape);
}

/**
 * Converts a complete Tool definition to Zod input/output schemas
 * for use with Genkit's defineTool
 */
export function toolToZodSchemas(tool: Tool): {
	input: z.ZodObject<Record<string, z.ZodTypeAny>>;
	output: z.ZodString;
} {
	const inputSchema = toolParametersToZod(tool.function.parameters);

	// Output is always a string for tool execution results
	const outputSchema = z.string().describe('Tool execution result');

	return {
		input: inputSchema,
		output: outputSchema,
	};
}
