import {genkit, modelRef, type Genkit, type ToolAction} from 'genkit';
import {openAICompatible} from '@genkit-ai/compat-oai';
import {Agent, fetch, type RequestInfo, type RequestInit} from 'undici';
import type {
	Message,
	Tool,
	LLMClient,
	LangChainProviderConfig,
	LLMChatResponse,
} from '@/types/index';
import {XMLToolCallParser} from '@/tool-calling/xml-parser';
import type {MessageData, Part} from 'genkit';
import {toolToZodSchemas} from '@/utils/json-schema-to-zod';
import type {z} from 'zod';

/**
 * Parses Genkit/API errors into user-friendly messages
 * Reuses the same error parsing logic from LangChain client
 */
function parseAPIError(error: unknown): string {
	if (!(error instanceof Error)) {
		return 'An unknown error occurred while communicating with the model';
	}

	const errorMessage = error.message;

	// Extract status code and clean message from common error patterns
	const statusMatch = errorMessage.match(
		/(?:Error: )?(\d{3})\s+(?:\d{3}\s+)?(?:Bad Request|[^:]+):\s*(.+)/i,
	);
	if (statusMatch) {
		const [, statusCode, message] = statusMatch;
		const cleanMessage = message.trim();

		switch (statusCode) {
			case '400':
				return `Bad request: ${cleanMessage}`;
			case '401':
				return 'Authentication failed: Invalid API key or credentials';
			case '403':
				return 'Access forbidden: Check your API permissions';
			case '404':
				return 'Model not found: The requested model may not exist or is unavailable';
			case '429':
				return 'Rate limit exceeded: Too many requests. Please wait and try again';
			case '500':
			case '502':
			case '503':
				return `Server error: ${cleanMessage}`;
			default:
				return `Request failed (${statusCode}): ${cleanMessage}`;
		}
	}

	// Handle timeout errors
	if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
		return 'Request timed out: The model took too long to respond';
	}

	// Handle network errors
	if (
		errorMessage.includes('ECONNREFUSED') ||
		errorMessage.includes('connect')
	) {
		return 'Connection failed: Unable to reach the model server';
	}

	// Handle context length errors
	if (
		errorMessage.includes('context length') ||
		errorMessage.includes('too many tokens')
	) {
		return 'Context too large: Please reduce the conversation length or message size';
	}

	// Handle token limit errors
	if (errorMessage.includes('reduce the number of tokens')) {
		return 'Too many tokens: Please shorten your message or clear conversation history';
	}

	// If we can't parse it, return a cleaned up version
	return errorMessage.replace(/^Error:\s*/i, '').split('\n')[0];
}

/**
 * Converts our Message format to Genkit MessageData format
 */
function convertToGenkitMessage(message: Message): MessageData {
	const parts: Part[] = [];

	// Add text content if present
	if (message.content) {
		parts.push({text: message.content});
	}

	// Add tool calls if present
	if (message.tool_calls && message.tool_calls.length > 0) {
		for (const toolCall of message.tool_calls) {
			parts.push({
				toolRequest: {
					ref: toolCall.id,
					name: toolCall.function.name,
					input: toolCall.function.arguments,
				},
			});
		}
	}

	// Handle tool response messages
	if (message.role === 'tool') {
		return {
			role: 'tool',
			content: [
				{
					toolResponse: {
						ref: message.tool_call_id || '',
						name: message.name || '',
						output: message.content || '',
					},
				},
			],
		};
	}

	return {
		role: message.role as 'user' | 'model' | 'system',
		content: parts,
	};
}

/**
 * Converts Genkit GenerateResponseData back to our Message format
 */
function convertFromGenkitResponse(response: any): Message {
	const result: Message = {
		role: 'assistant',
		content: '',
	};

	// Use the .text getter from GenerateResponse class
	// This properly extracts and concatenates all text parts from the response
	if (response.text !== undefined && response.text !== null) {
		result.content = response.text;
	}

	// Extract tool requests from response
	const toolCalls: Array<{
		id: string;
		function: {name: string; arguments: Record<string, unknown>};
	}> = [];

	if (response.message?.content) {
		for (const part of response.message.content) {
			if ('toolRequest' in part && part.toolRequest) {
				toolCalls.push({
					id: part.toolRequest.ref || '',
					function: {
						name: part.toolRequest.name,
						arguments: part.toolRequest.input as Record<string, unknown>,
					},
				});
			}
		}
	}

	// Also check toolRequests getter if available
	if (!toolCalls.length && response.toolRequests) {
		for (const toolRequest of response.toolRequests) {
			toolCalls.push({
				id: toolRequest.ref || '',
				function: {
					name: toolRequest.name,
					arguments: toolRequest.input as Record<string, unknown>,
				},
			});
		}
	}

	if (toolCalls.length > 0) {
		result.tool_calls = toolCalls;
	}

	return result;
}

/**
 * Converts nanocoder JSON Schema tool to Genkit ToolAction
 * Uses proper JSON Schema to Zod conversion and creates a dynamic tool
 */
function convertToolToGenkitAction(
	ai: Genkit,
	tool: Tool,
): ToolAction<z.ZodTypeAny, z.ZodTypeAny> {
	const {input, output} = toolToZodSchemas(tool);

	// Use dynamicTool to create a tool action without registering it
	// The tool will be executed by nanocoder's tool manager, not by Genkit
	return ai.dynamicTool(
		{
			name: tool.function.name,
			description: tool.function.description,
			inputSchema: input as z.ZodTypeAny,
			outputSchema: output as z.ZodTypeAny,
		},
		// Dummy function since tools are actually executed by nanocoder's tool manager
		// eslint-disable-next-line @typescript-eslint/require-await
		async () => {
			return 'Tool will be executed by nanocoder tool manager';
		},
	);
}

interface ModelInfo {
	context_length?: number;
	[key: string]: unknown;
}

export class GenkitClient implements LLMClient {
	private ai: Genkit;
	private currentModel: string;
	private availableModels: string[];
	private providerConfig: LangChainProviderConfig;
	private modelInfoCache: Map<string, ModelInfo> = new Map();
	private undiciAgent: Agent;

	constructor(providerConfig: LangChainProviderConfig) {
		this.providerConfig = providerConfig;
		this.availableModels = providerConfig.models;
		this.currentModel = providerConfig.models[0] || '';

		// Set up undici agent for custom fetch
		const {requestTimeout, socketTimeout, connectionPool} = this.providerConfig;
		const resolvedSocketTimeout =
			socketTimeout === -1
				? 0
				: socketTimeout || requestTimeout === -1
				? 0
				: requestTimeout || 120000;

		this.undiciAgent = new Agent({
			connect: {
				timeout: resolvedSocketTimeout,
			},
			bodyTimeout: resolvedSocketTimeout,
			headersTimeout: resolvedSocketTimeout,
			keepAliveTimeout: connectionPool?.idleTimeout,
			keepAliveMaxTimeout: connectionPool?.cumulativeMaxIdleTimeout,
		});

		// Initialize Genkit with OpenAI-compatible plugin
		this.ai = this.createGenkitInstance();
	}

	static create(
		providerConfig: LangChainProviderConfig,
	): Promise<GenkitClient> {
		const client = new GenkitClient(providerConfig);
		return Promise.resolve(client);
	}

	private createGenkitInstance(): Genkit {
		const {config, requestTimeout} = this.providerConfig;

		// Custom fetch using undici with LM Studio workaround
		// LM Studio includes empty tool_calls: [] which breaks Genkit's parser
		const customFetch = async (
			url: string | URL | Request,
			options: RequestInit = {},
		) => {
			const response = await fetch(url as RequestInfo, {
				...options,
				signal: options.signal,
				dispatcher: this.undiciAgent,
			});

			// Clone to read the body without consuming it
			const clone = response.clone();
			const text = await clone.text();
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			const data = JSON.parse(text);

			// Workaround for LM Studio: Remove empty tool_calls array
			// Genkit's parser fails when tool_calls is an empty array
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			if (data.choices) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				for (const choice of data.choices) {
					if (
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						choice.message &&
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						Array.isArray(choice.message.tool_calls) &&
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						choice.message.tool_calls.length === 0
					) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						delete choice.message.tool_calls;
					}
				}
			}

			// Return modified response as standard Response
			// Convert headers to plain object
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});

			return new Response(JSON.stringify(data), {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		};

		// Add OpenRouter-specific headers
		const defaultHeaders: Record<string, string> = {};
		if (this.providerConfig.name.toLowerCase() === 'openrouter') {
			defaultHeaders['HTTP-Referer'] =
				'https://github.com/Nano-Collective/nanocoder';
			defaultHeaders['X-Title'] = 'Nanocoder';
		}

		// Configure timeout
		const timeout =
			requestTimeout === -1 ? undefined : requestTimeout || 120000;

		// Create Genkit instance with OpenAI-compatible plugin
		const pluginOptions: any = {
			name: this.providerConfig.name,
			apiKey: config.apiKey ?? 'dummy-key',
			baseURL: config.baseURL,
			timeout,
			defaultHeaders,
		};

		// Only add fetch if customFetch is defined
		if (customFetch) {
			pluginOptions.fetch = customFetch;
		}

		return genkit({
			plugins: [openAICompatible(pluginOptions)],
		});
	}

	setModel(model: string): void {
		this.currentModel = model;
		// Recreate Genkit instance when model changes
		// This ensures the correct model is used
		this.ai = this.createGenkitInstance();
	}

	getCurrentModel(): string {
		return this.currentModel;
	}

	getContextSize(): number {
		// For OpenRouter, get from cached model info
		if (this.providerConfig.name.toLowerCase() === 'openrouter') {
			const modelData = this.modelInfoCache.get(this.currentModel);
			if (modelData?.context_length) {
				return modelData.context_length;
			}
			return 0;
		}

		// For OpenAI-compatible (local models), we can't reliably know the context
		if (this.providerConfig.name === 'openai-compatible') {
			return 0;
		}

		return 0;
	}

	getAvailableModels(): Promise<string[]> {
		return Promise.resolve(this.availableModels);
	}

	async chat(
		messages: Message[],
		tools: Tool[],
		signal?: AbortSignal,
	): Promise<LLMChatResponse> {
		// Check if already aborted before starting
		if (signal?.aborted) {
			throw new Error('Operation was cancelled');
		}

		try {
			// Convert messages to Genkit format
			const genkitMessages = messages.map(convertToGenkitMessage);

			// Convert tools to Genkit format (if provided)
			const genkitTools: ToolAction<z.ZodTypeAny, z.ZodTypeAny>[] | undefined =
				tools.length > 0
					? tools.map(tool => convertToolToGenkitAction(this.ai, tool))
					: undefined;

			// Call Genkit's generate method
			// Use the model reference with provider name prefix
			// Create a proper modelRef using the modelRef() function
			const model = modelRef({
				name: `${this.providerConfig.name}/${this.currentModel}`,
			});

			// Create generate options
			// Note: Genkit doesn't directly support AbortSignal in the API
			// but we've configured undici fetch with proper signal handling

			// Build generate options - only include tools if they exist
			const generateOptions: any = {
				model,
				messages: genkitMessages,
				config: {},
			};

			if (genkitTools && genkitTools.length > 0) {
				generateOptions.tools = genkitTools;
			}

			const response = await this.ai.generate(generateOptions);

			let convertedMessage = convertFromGenkitResponse(response);

			// If no native tool calls but tools are available, try XML parsing
			if (
				tools.length > 0 &&
				(!convertedMessage.tool_calls ||
					convertedMessage.tool_calls.length === 0) &&
				convertedMessage.content
			) {
				const content = convertedMessage.content;

				if (XMLToolCallParser.hasToolCalls(content)) {
					const parsedToolCalls = XMLToolCallParser.parseToolCalls(content);
					const toolCalls =
						XMLToolCallParser.convertToToolCalls(parsedToolCalls);
					const cleanedContent =
						XMLToolCallParser.removeToolCallsFromContent(content);

					convertedMessage = {
						...convertedMessage,
						content: cleanedContent,
						tool_calls: toolCalls,
					};
				}
			}

			return {
				choices: [
					{
						message: {
							role: 'assistant' as const,
							content: convertedMessage.content,
							tool_calls: convertedMessage.tool_calls,
						},
					},
				],
			};
		} catch (error) {
			// Check if this was a cancellation
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error('Operation was cancelled');
			}

			// Parse and throw a user-friendly error
			const userMessage = parseAPIError(error);
			throw new Error(userMessage);
		}
	}

	async clearContext(): Promise<void> {
		// No internal state to clear in stateless approach
	}
}
