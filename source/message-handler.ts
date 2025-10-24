import type {ToolCall, ToolResult, ToolHandler} from '@/types/index';
import type {ToolManager} from '@/tools/tool-manager';

// This will be set by the ChatSession
let toolRegistryGetter: (() => Record<string, ToolHandler>) | null = null;

// This will be set by the App
let toolManagerGetter: (() => ToolManager | null) | null = null;

export function setToolRegistryGetter(
	getter: () => Record<string, ToolHandler>,
) {
	toolRegistryGetter = getter;
}

export function setToolManagerGetter(getter: () => ToolManager | null) {
	toolManagerGetter = getter;
}

export function getToolManager(): ToolManager | null {
	return toolManagerGetter ? toolManagerGetter() : null;
}

/**
 * Normalize tool arguments to match expected types from tool schemas.
 * Some LLMs pass objects for 'content' parameters when schemas specify strings.
 */
function normalizeToolArguments(
	args: Record<string, any>,
	toolName: string,
): Record<string, any> {
	// Convert content parameter to string if it's an object
	if ('content' in args && typeof args.content !== 'string') {
		if (args.content === null || args.content === undefined) {
			args.content = '';
		} else {
			// Convert objects/arrays to JSON string
			try {
				args.content = JSON.stringify(args.content, null, 2);
				console.warn(
					`[${toolName}] Content parameter was ${typeof args.content}, converted to JSON string`,
				);
			} catch (error) {
				console.error(`[${toolName}] Failed to stringify content:`, error);
				args.content = '';
			}
		}
	}

	return args;
}

export async function processToolUse(toolCall: ToolCall): Promise<ToolResult> {
	if (!toolRegistryGetter) {
		throw new Error('Tool registry not initialized');
	}

	const toolRegistry = toolRegistryGetter();
	const handler = toolRegistry[toolCall.function.name];
	if (!handler) {
		throw new Error(`Unknown tool: ${toolCall.function.name}`);
	}

	try {
		// Parse arguments if they're a JSON string
		let parsedArgs: Record<string, unknown> = toolCall.function.arguments;
		if (typeof parsedArgs === 'string') {
			try {
				parsedArgs = JSON.parse(parsedArgs) as Record<string, unknown>;
			} catch (e) {
				throw new Error(`Invalid tool arguments: ${(e as Error).message}`);
			}
		}

		// Normalize arguments (e.g., convert non-string content to strings)
		parsedArgs = normalizeToolArguments(parsedArgs, toolCall.function.name);

		const result = await handler(parsedArgs);
		return {
			tool_call_id: toolCall.id,
			role: 'tool',
			name: toolCall.function.name,
			content: result,
		};
	} catch (error) {
		// Convert exceptions to error messages that the model can see and correct
		const errorMessage = `Error: ${
			error instanceof Error ? error.message : String(error)
		}`;
		return {
			tool_call_id: toolCall.id,
			role: 'tool',
			name: toolCall.function.name,
			content: errorMessage,
		};
	}
}
