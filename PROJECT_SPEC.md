# Project Specification: LangChain to Genkit Migration

## 1. Project Overview

### 1.1 Objective

Replace the current LangChain-based LLM client implementation with Google's Genkit framework to simplify the codebase, improve maintainability, and leverage Genkit's production-ready features while maintaining 100% backward compatibility with existing functionality.

### 1.2 Scope

**In Scope**:

- Complete replacement of `LangGraphClient` with `GenkitClient`
- Tool calling with native and XML fallback support
- All existing LLM client features (chat, model selection, context size, etc.)
- Support for all currently supported providers (Ollama, OpenRouter, custom OpenAI-compatible)
- Network configuration (timeouts, connection pooling, custom headers)
- Error handling and user-friendly messages
- AbortSignal support for cancellation
- JSON Schema to Zod conversion for tool definitions

**Out of Scope**:

- Streaming support (not currently implemented)
- Changes to UI/UX
- Changes to tool implementations
- Changes to MCP server integration (beyond schema conversion)
- Changes to configuration format (maintain backward compatibility)
- Performance optimizations (maintain current performance)

### 1.3 Success Criteria

1. All existing tests pass without modification
2. Manual testing shows no functional regressions
3. Code is simpler and more maintainable
4. Documentation is updated and accurate
5. No breaking changes for end users
6. Performance is within 10% of current implementation

## 2. Technical Requirements

### 2.1 Dependencies

#### New Dependencies

```json
{
	"genkit": "latest",
	"@genkit-ai/compat-oai": "latest",
	"zod": "^3.x.x"
}
```

#### Dependencies to Remove (after migration complete)

```json
{
	"@langchain/core": "^0.3.72",
	"@langchain/openai": "^0.6.15"
}
```

#### Dependencies to Keep

```json
{
	"undici": "^7.16.0" // For custom fetch control
}
```

### 2.2 Interface Requirements

The new `GenkitClient` must implement the existing `LLMClient` interface:

```typescript
export interface LLMClient {
	getCurrentModel(): string;
	setModel(model: string): void;
	getContextSize(): number;
	getAvailableModels(): Promise<string[]>;
	chat(
		messages: Message[],
		tools: Tool[],
		signal?: AbortSignal,
	): Promise<LLMChatResponse>;
	clearContext(): Promise<void>;
}
```

### 2.3 Message Format Requirements

**Input Messages** (`Message` type):

- `role`: 'user' | 'assistant' | 'system' | 'tool'
- `content`: string
- `tool_calls?`: Array of ToolCall objects
- `tool_call_id?`: string (for tool role)
- `name?`: string (for tool role)

**Output Format** (`LLMChatResponse`):

```typescript
{
  choices: [{
    message: {
      role: 'assistant',
      content: string,
      tool_calls?: ToolCall[]
    }
  }]
}
```

**Tool Call Format**:

```typescript
{
  id: string,
  function: {
    name: string,
    arguments: Record<string, unknown>
  }
}
```

### 2.4 Tool Calling Requirements

#### Native Tool Calling

- Convert JSON Schema tool definitions to Zod schemas
- Use Genkit's `defineTool()` for tool registration
- Pass tools to `generate()` via `tools` parameter
- Handle tool call requests and responses
- Support parallel tool calls (if model supports)

#### XML Fallback Support

- Preserve `XMLToolCallParser` for models without native tool calling
- Check response content for XML tool calls
- Convert XML tool calls to standard ToolCall format
- Remove XML from response content
- Maintain same XML format requirements as current implementation

#### Tool Schema Conversion

Create utility to convert JSON Schema to Zod:

- Support types: string, number, boolean, object, array
- Support nested objects and arrays
- Handle required vs optional fields
- Preserve descriptions for AI guidance
- Handle enums and const values
- Support additionalProperties

### 2.5 Network Configuration Requirements

#### Timeout Configuration

- `requestTimeout`: Overall request timeout (default: 120000ms / 2 minutes)
- `socketTimeout`: Socket-level timeout (default: same as requestTimeout)
- Value of `-1` disables timeout
- Pass to Genkit via `ClientOptions.timeout`

#### Connection Pooling

- `idleTimeout`: Keep-alive timeout for idle connections
- `cumulativeMaxIdleTimeout`: Maximum cumulative idle time
- Configure via undici Agent if Genkit supports custom fetch

#### Custom Headers

- OpenRouter: Add `HTTP-Referer` and `X-Title` headers
- Support for additional provider-specific headers
- Pass via `ClientOptions.defaultHeaders`

#### Custom Fetch

- Use undici's `fetch` with custom Agent for timeout control
- Preserve AbortSignal from options
- Configure dispatcher with undici Agent

### 2.6 Provider Support Requirements

#### OpenRouter

- Base URL: https://openrouter.ai/api/v1
- Custom headers: `HTTP-Referer`, `X-Title`
- API key required
- Context length from model info cache
- Model list from configuration

#### Ollama (Local)

- Base URL: http://localhost:11434/v1 (or custom port)
- No API key required (or dummy key accepted)
- Connection test before initialization
- Context length: return 0 (unknown)
- Model list from configuration

#### OpenAI-Compatible (Generic)

- Custom base URL
- API key may be optional (local servers)
- Connection test for localhost URLs
- Context length: return 0 or from model metadata
- Model list from configuration

#### Multi-Provider Fallback

- Try requested provider first
- Fallback to other configured providers on failure
- Test connection before creating client
- Collect and report all errors if all providers fail

### 2.7 Error Handling Requirements

#### API Error Parsing

Parse and convert API errors to user-friendly messages:

- 400: "Bad request: [message]"
- 401: "Authentication failed: Invalid API key or credentials"
- 403: "Access forbidden: Check your API permissions"
- 404: "Model not found: The requested model may not exist or is unavailable"
- 429: "Rate limit exceeded: Too many requests. Please wait and try again"
- 500/502/503: "Server error: [message]"
- Timeout: "Request timed out: The model took too long to respond"
- Connection: "Connection failed: Unable to reach the model server"
- Context length: "Context too large: Please reduce the conversation length or message size"

#### Cancellation Handling

- Check `signal.aborted` before starting request
- Pass signal to Genkit's `generate()` call
- Catch `AbortError` and throw "Operation was cancelled"
- Clean up resources on cancellation

#### Error Propagation

- Throw user-friendly error messages
- Preserve original error for debugging (log internally if needed)
- Handle Genkit-specific errors gracefully

### 2.8 Configuration Requirements

#### Provider Configuration Format

Maintain existing `LangChainProviderConfig` structure initially:

```typescript
{
  name: string,                    // Provider name (e.g., "openrouter", "ollama")
  type: 'openai',                  // Always 'openai' for OpenAI-compatible
  models: string[],                // List of available models
  requestTimeout?: number,         // Request timeout in ms (-1 to disable)
  socketTimeout?: number,          // Socket timeout in ms (-1 to disable)
  connectionPool?: {
    idleTimeout?: number,
    cumulativeMaxIdleTimeout?: number
  },
  config: {
    baseURL?: string,              // Provider API base URL
    apiKey?: string,               // API key (or 'dummy-key' for local)
    [key: string]: unknown
  }
}
```

#### Genkit Configuration

Map provider config to Genkit's OpenAI-compatible plugin:

```typescript
openAICompatible({
  name: providerConfig.name,
  apiKey: providerConfig.config.apiKey,
  baseURL: providerConfig.config.baseURL,
  timeout: providerConfig.requestTimeout,
  defaultHeaders: {...},
  // Custom fetch if needed for undici
})
```

### 2.9 Testing Requirements

#### Unit Tests

1. **Message Conversion**:

   - User messages with and without content
   - Assistant messages with and without tool calls
   - System messages
   - Tool messages with tool_call_id
   - Edge cases: empty content, multiple tool calls, missing fields

2. **Tool Schema Conversion**:

   - Simple types (string, number, boolean)
   - Objects with nested properties
   - Arrays with item schemas
   - Required vs optional fields
   - Enums and const values
   - All built-in tool schemas
   - Complex MCP tool schemas

3. **XML Parsing**:

   - XML tool calls in content
   - Multiple tool calls
   - Nested parameters
   - JSON-encoded parameter values
   - Removal of XML from content
   - Detection of XML tool calls

4. **Error Handling**:
   - API errors (400, 401, 403, 404, 429, 500, 502, 503)
   - Network errors (timeout, connection refused)
   - Cancellation errors
   - Context length errors
   - Invalid configuration errors

#### Integration Tests

1. **Provider Tests**:

   - Ollama localhost connection
   - OpenRouter with valid API key
   - Custom OpenAI-compatible server
   - Multi-provider fallback
   - Connection failure handling

2. **Tool Calling Tests**:

   - Native tool calling with GPT-4, Claude, etc.
   - XML fallback with non-supporting models
   - Tool execution and response handling
   - Tool call errors
   - Multiple sequential tool calls

3. **Conversation Tests**:

   - Multi-turn conversation
   - Conversation with tool usage
   - Model switching mid-conversation
   - Context size limits
   - Message history management

4. **Cancellation Tests**:
   - Cancel before request starts
   - Cancel during request
   - Cancel after completion
   - Multiple cancellations

#### Manual Testing Checklist

- [ ] Basic chat with Ollama
- [ ] Basic chat with OpenRouter
- [ ] Tool calling with read-file
- [ ] Tool calling with search-files
- [ ] Tool calling with execute-bash
- [ ] Multiple sequential tool calls
- [ ] Auto-accept mode
- [ ] Plan mode
- [ ] Model switching
- [ ] Provider switching
- [ ] Custom commands
- [ ] MCP server tools
- [ ] Cancellation (Ctrl+C)
- [ ] Error scenarios (invalid API key, unreachable server, etc.)
- [ ] Long conversation (context management)

## 3. Implementation Details

### 3.1 File Structure

#### New Files

- `source/genkit-client.ts`: Main Genkit client implementation
- `source/utils/json-schema-to-zod.ts`: JSON Schema to Zod converter
- `source/genkit-client.spec.ts`: Unit tests for Genkit client

#### Modified Files

- `source/client-factory.ts`: Switch to GenkitClient
- `source/types/config.ts`: Update type names if needed
- `package.json`: Update dependencies

#### Deleted Files (after migration)

- `source/langgraph-client.ts`: Old LangChain implementation

#### Preserved Files

- `source/tool-calling/xml-parser.ts`: Keep for XML fallback
- All tool definitions: No changes required
- All UI components: No changes required
- All hooks: No changes required

### 3.2 GenkitClient Class Structure

```typescript
export class GenkitClient implements LLMClient {
	private ai: Genkit;
	private currentModel: string;
	private availableModels: string[];
	private providerConfig: LangChainProviderConfig;
	private modelRef: ModelReference;
	private tools: Map<string, DefinedTool>;
	private undiciAgent: Agent;

	constructor(providerConfig: LangChainProviderConfig) {
		// Initialize Genkit instance
		// Configure OpenAI-compatible plugin
		// Set up undici agent for custom fetch
		// Initialize model reference
	}

	static async create(
		providerConfig: LangChainProviderConfig,
	): Promise<GenkitClient> {
		// Factory method for async initialization
	}

	private createGenkitInstance(): Genkit {
		// Configure Genkit with OpenAI-compatible plugin
		// Set up custom fetch with undici
		// Configure headers, timeout, etc.
	}

	private registerTools(tools: Tool[]): void {
		// Convert JSON Schema to Zod
		// Register with defineTool()
		// Cache tool definitions
	}

	setModel(model: string): void {
		// Update model reference
	}

	getCurrentModel(): string {
		// Return current model name
	}

	getContextSize(): number {
		// Return context window size
		// Handle provider-specific logic
	}

	getAvailableModels(): Promise<string[]> {
		// Return model list from config
	}

	async chat(
		messages: Message[],
		tools: Tool[],
		signal?: AbortSignal,
	): Promise<LLMChatResponse> {
		// Convert messages to Genkit format
		// Register/update tools
		// Call generate() with abort signal
		// Handle tool calls (native or XML)
		// Convert response to LLMChatResponse
		// Handle errors
	}

	async clearContext(): Promise<void> {
		// No-op (stateless)
	}
}
```

### 3.3 JSON Schema to Zod Converter

```typescript
export function jsonSchemaToZod(schema: ToolParameterSchema): z.ZodType {
	// Handle type: string, number, boolean, object, array
	// Handle nested objects
	// Handle arrays with item schemas
	// Handle required fields
	// Handle enums and const
	// Attach descriptions
	// Return Zod schema
}

export function toolToZodSchema(tool: Tool): {
	input: z.ZodObject<any>;
	output: z.ZodType;
} {
	// Convert tool.function.parameters to Zod object schema
	// Create simple string output schema
	// Return input/output schemas
}
```

### 3.4 Message Conversion

```typescript
function convertToGenkitMessage(message: Message): GenkitMessage {
	// Map role: user -> user, assistant -> assistant, system -> system, tool -> tool
	// Convert content
	// Convert tool_calls if present
	// Handle tool_call_id for tool messages
	// Return Genkit message format
}

function convertFromGenkitMessage(message: GenkitMessage): Message {
	// Extract role, content, tool_calls
	// Convert tool calls to nanocoder format
	// Return Message
}
```

### 3.5 Tool Calling Flow

```typescript
async function handleToolCalling(
	response: GenerateResponse,
	tools: Tool[],
): Promise<Message> {
	// Check for native tool calls in response
	if (response.toolCalls && response.toolCalls.length > 0) {
		// Convert to nanocoder ToolCall format
		return {
			role: 'assistant',
			content: response.text,
			tool_calls: convertToolCalls(response.toolCalls),
		};
	}

	// Fallback to XML parsing if no native tool calls
	if (tools.length > 0 && XMLToolCallParser.hasToolCalls(response.text)) {
		const parsedToolCalls = XMLToolCallParser.parseToolCalls(response.text);
		const toolCalls = XMLToolCallParser.convertToToolCalls(parsedToolCalls);
		const cleanedContent = XMLToolCallParser.removeToolCallsFromContent(
			response.text,
		);

		return {
			role: 'assistant',
			content: cleanedContent,
			tool_calls: toolCalls,
		};
	}

	// No tool calls, return plain message
	return {
		role: 'assistant',
		content: response.text,
	};
}
```

## 4. Migration Process

### 4.1 Development Branch Strategy

1. Create feature branch: `feature/genkit-migration`
2. Implement in phases (each phase = separate commit)
3. Run tests after each phase
4. Manual testing after Phase 4
5. Code review before merge
6. Merge to `genkit` branch first for extended testing
7. Merge to `main` after user testing

### 4.2 Rollback Strategy

1. **Phase 1-3**: Simple revert of commits
2. **Phase 4**: Keep both implementations, use environment variable to switch
3. **Phase 5**: If issues found post-merge, revert single commit to restore LangChain

### 4.3 Communication Plan

1. Open GitHub issue describing migration and rationale
2. Notify users of upcoming change
3. Request beta testers for `genkit` branch
4. Collect feedback before merging to main
5. Update changelog with migration notes
6. Provide troubleshooting guide for common issues

## 5. Risks and Mitigations

### 5.1 Critical Risks

| Risk                                | Impact | Probability | Mitigation                                     | Contingency                  |
| ----------------------------------- | ------ | ----------- | ---------------------------------------------- | ---------------------------- |
| Genkit doesn't support XML fallback | High   | Medium      | Preserve XMLToolCallParser, integrate manually | Keep LangChain as dependency |
| Provider compatibility issues       | High   | Low         | Test all providers early                       | Provider-specific handling   |
| Performance degradation             | Medium | Low         | Benchmark both implementations                 | Optimize or revert           |
| Breaking changes to tool format     | High   | Low         | Extensive testing with all tools               | Conversion layer             |

### 5.2 Medium Risks

| Risk                              | Impact | Probability | Mitigation                                 | Contingency            |
| --------------------------------- | ------ | ----------- | ------------------------------------------ | ---------------------- |
| Complex schema conversion fails   | Medium | Medium      | Test with real schemas, fallback to manual | Manual Zod definitions |
| Network configuration limitations | Medium | Low         | Use undici directly if needed              | Custom fetch wrapper   |
| Error message format changes      | Low    | Medium      | Careful error parsing                      | Update error parser    |
| User confusion                    | Low    | Medium      | Clear documentation and changelog          | Support guide          |

## 6. Documentation Updates

### 6.1 CLAUDE.md Updates

- Replace LangChain references with Genkit
- Update architecture overview section
- Update LLM client architecture section
- Add Zod schema section
- Update dependencies section
- Update testing patterns if needed

### 6.2 README.md Updates

- Update dependencies list
- Update feature list if Genkit adds capabilities
- Update installation instructions
- Add migration notes for existing users

### 6.3 Code Comments

- Add JSDoc comments to GenkitClient methods
- Document JSON Schema to Zod conversion
- Document XML fallback integration
- Document provider-specific behavior

### 6.4 CHANGELOG.md

Add entry:

```markdown
## [X.X.X] - YYYY-MM-DD

### Changed

- **BREAKING**: Replaced LangChain with Genkit for LLM client implementation
  - No functional changes for end users
  - Improved maintainability and code simplicity
  - Better integration with Google's AI ecosystem
  - See MIGRATION.md for details

### Migration Notes

- No configuration changes required
- All existing features maintained
- If you encounter issues, please report at [GitHub Issues]
- See IMPLEMENTATION_PLAN.md for technical details
```

## 7. Success Metrics

### 7.1 Functional Metrics

- [ ] 100% of existing tests pass
- [ ] 100% of manual test checklist complete
- [ ] 0 reported regressions in first week
- [ ] All providers working (Ollama, OpenRouter, custom)

### 7.2 Code Quality Metrics

- [ ] Lines of code reduced by >20% (estimated)
- [ ] Cyclomatic complexity reduced
- [ ] Test coverage maintained or improved
- [ ] No new linting warnings

### 7.3 Performance Metrics

- [ ] Chat latency within 10% of baseline
- [ ] Memory usage within 10% of baseline
- [ ] Startup time within 10% of baseline

### 7.4 User Satisfaction Metrics

- [ ] No breaking changes reported
- [ ] Positive feedback from beta testers
- [ ] No support requests related to migration
- [ ] Documentation rated as helpful

## 8. Appendices

### 8.1 Genkit Resources

- Official Documentation: https://genkit.dev/docs/
- OpenAI-Compatible Plugin: https://genkit.dev/docs/integrations/openai-compatible/
- Tool Calling Guide: https://genkit.dev/docs/tool-calling/
- GitHub Repository: https://github.com/firebase/genkit

### 8.2 Current LangChain Resources

- LangChain OpenAI: https://js.langchain.com/docs/integrations/chat/openai
- LangChain Core Messages: https://js.langchain.com/docs/api/core/messages
- Tool Binding: https://js.langchain.com/docs/how_to/tool_calling

### 8.3 Zod Resources

- Zod Documentation: https://zod.dev/
- Zod Schema Definition: https://zod.dev/?id=basic-usage
- Zod Type Inference: https://zod.dev/?id=type-inference

### 8.4 Related Issues

- [To be filled with GitHub issue number]

### 8.5 Glossary

- **Genkit**: Google's AI framework for building production-ready AI applications
- **LangChain**: Framework for developing applications powered by language models
- **Zod**: TypeScript-first schema validation with static type inference
- **OpenAI-compatible API**: APIs that follow OpenAI's API specification
- **Tool Calling**: Feature allowing AI models to request execution of functions
- **XML Fallback**: Alternative tool calling format for models without native support
- **Undici**: Node.js HTTP client with advanced networking features
- **AbortSignal**: Standard API for cancelling asynchronous operations
