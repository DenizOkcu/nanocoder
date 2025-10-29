# Implementation Plan: Replace LangChain with Genkit

## Executive Summary

This plan outlines the migration from LangChain to Genkit in the nanocoder project. Genkit is Google's production-ready AI framework that provides unified APIs for multiple AI providers with built-in tool calling support. The migration will maintain all current functionality while potentially simplifying the codebase and improving maintainability.

## Current Architecture Analysis

### LangChain Implementation

The current implementation uses LangChain with the following key components:

1. **LangGraphClient** (`source/langgraph-client.ts`):

   - Uses `@langchain/openai` package's `ChatOpenAI` class
   - Supports OpenAI-compatible APIs through `baseURL` configuration
   - Message conversion between nanocoder format and LangChain's `BaseMessage` types
   - Dual tool calling: native via `.bindTools()` + XML fallback for non-supporting models
   - Custom fetch using undici with configurable timeouts and connection pooling
   - Provider-specific features (OpenRouter headers)
   - Error parsing for user-friendly messages

2. **Dependencies**:

   - `@langchain/core`: ^0.3.72
   - `@langchain/openai`: ^0.6.15
   - `undici`: ^7.16.0

3. **Message Flow**:

   - Converts `Message[]` → `BaseMessage[]` → LangChain processing → `AIMessage` → `Message`
   - Tool calls in both native format and XML format (fallback)

4. **Tool Calling**:
   - Native: LangChain's `.bindTools()` with JSON Schema
   - Fallback: Custom `XMLToolCallParser` for models without native support
   - Tools defined with OpenAI function calling schema

## Genkit Architecture Analysis

### Key Features

1. **OpenAI-Compatible Plugin** (`@genkit-ai/compat-oai`):

   - Unified interface for OpenAI-compatible providers
   - Native support for custom base URLs and API keys
   - Built-in tool calling via `defineTool()` with Zod schemas
   - Automatic tool calling loop with configurable `maxTurns`
   - Support for `ClientOptions` (timeout, headers, etc.)

2. **Tool Calling**:

   - Define tools with `defineTool()` using Zod schemas
   - Pass tools via `tools` parameter to `generate()`
   - Automatic request/response loop handling
   - Manual control via `returnToolRequests: true`
   - Model capability checking via `info.supports.tools`

3. **Message Format**:

   - Uses standard OpenAI message format
   - Native support for system, user, assistant, and tool roles
   - Streaming support with tool call chunks

4. **Error Handling**:
   - Built-in error checking for unsupported features
   - Custom error handling in tool execution

## Migration Strategy

### Phase 1: Setup and Dependencies

**Goal**: Install Genkit packages and prepare the environment

**Tasks**:

1. Install Genkit core packages:

   ```bash
   pnpm add genkit @genkit-ai/compat-oai zod
   ```

2. Remove LangChain dependencies (after migration complete):

   ```bash
   pnpm remove @langchain/core @langchain/openai
   ```

3. Update TypeScript configuration if needed for Zod

**Success Criteria**:

- Genkit packages installed successfully
- No TypeScript compilation errors
- All tests still pass (no breaking changes yet)

### Phase 2: Create Genkit Client Implementation

**Goal**: Implement a new `GenkitClient` class that mirrors `LangGraphClient`'s interface

**Tasks**:

1. Create `source/genkit-client.ts` implementing the `LLMClient` interface:

   - Constructor accepting `LangChainProviderConfig` (keep same config format initially)
   - Initialize Genkit with `@genkit-ai/compat-oai` plugin
   - Configure custom provider with baseURL, apiKey, timeout settings
   - Implement model selection via `modelRef`

2. Message format conversion:

   - Convert nanocoder's `Message` format to Genkit's format
   - Handle system, user, assistant, and tool messages
   - Convert tool calls to/from Genkit format

3. Tool calling integration:

   - Convert nanocoder's JSON Schema tools to Zod schemas
   - Use `defineTool()` to register tools dynamically
   - Pass tools to `generate()` call
   - Handle tool call responses and convert to nanocoder format
   - Preserve XML fallback support for non-tool-calling models

4. Network configuration:

   - Configure timeout via `ClientOptions`
   - Set up custom headers (OpenRouter attribution)
   - Handle AbortSignal for cancellation
   - Configure connection pooling if supported

5. Error handling:

   - Implement `parseAPIError()` equivalent
   - Handle cancellation (AbortError)
   - User-friendly error messages

6. Implement all `LLMClient` interface methods:
   - `chat(messages, tools, signal)`: Main generation method
   - `getCurrentModel()`: Return current model name
   - `setModel(model)`: Switch models
   - `getContextSize()`: Return context window size
   - `getAvailableModels()`: List available models
   - `clearContext()`: No-op (stateless)

**Key Considerations**:

- Maintain exact same interface as `LangGraphClient` for drop-in replacement
- Preserve XML fallback for models without native tool calling
- Keep undici for custom fetch if Genkit doesn't provide equivalent control
- Maintain OpenRouter-specific headers

**Success Criteria**:

- `GenkitClient` implements all `LLMClient` methods
- Unit tests pass for message conversion
- Tool calling works with native and XML fallback
- Network configuration matches current behavior

### Phase 3: Tool Schema Conversion

**Goal**: Convert JSON Schema tool definitions to Zod schemas

**Tasks**:

1. Create utility function `jsonSchemaToZod()`:

   - Convert JSON Schema `properties` to Zod object schema
   - Handle `type`, `description`, `required` fields
   - Support common types: string, number, boolean, object, array
   - Handle nested objects and arrays

2. Update tool registration in `ToolManager`:

   - Keep JSON Schema format in tool definitions (public API)
   - Convert to Zod internally when registering with Genkit
   - Cache converted schemas

3. Test tool schema conversion:
   - Verify all existing tools convert correctly
   - Ensure MCP tools work with conversion

**Success Criteria**:

- All built-in tools convert to Zod successfully
- MCP tools work with converted schemas
- Tool calling maintains same behavior

### Phase 4: Integration and Testing

**Goal**: Integrate GenkitClient into client-factory and test thoroughly

**Tasks**:

1. Update `source/client-factory.ts`:

   - Replace `LangGraphClient.create()` with `GenkitClient.create()`
   - Keep fallback logic and connection testing
   - Maintain configuration loading

2. Comprehensive testing:

   - Run existing unit tests
   - Test with multiple providers (Ollama, OpenRouter, custom)
   - Test tool calling (native and XML fallback)
   - Test cancellation with AbortSignal
   - Test error handling scenarios
   - Test network timeout behavior
   - Test model switching

3. Manual testing:
   - Test basic chat interactions
   - Test tool calling workflows
   - Test auto-accept mode
   - Test plan mode
   - Test MCP server integration
   - Test custom commands

**Success Criteria**:

- All automated tests pass
- Manual testing shows no regressions
- Performance is equivalent or better
- Error messages are user-friendly

### Phase 5: Cleanup and Documentation

**Goal**: Remove LangChain code and update documentation

**Tasks**:

1. Remove old implementation:

   - Delete `source/langgraph-client.ts`
   - Remove LangChain dependencies from `package.json`
   - Update imports across codebase

2. Update type definitions:

   - Rename `LangChainProviderConfig` to `ProviderConfig` if needed
   - Update type exports

3. Update documentation:

   - Update `CLAUDE.md` to reference Genkit instead of LangChain
   - Update architecture documentation
   - Add notes about Zod schema usage
   - Document any new Genkit-specific features

4. Update tests:
   - Remove any LangChain-specific test mocks
   - Update test descriptions

**Success Criteria**:

- No LangChain code remains
- All documentation is accurate
- All tests pass
- No unused dependencies

## Risk Assessment

### High Risk Areas

1. **Tool Calling Compatibility**:

   - **Risk**: Genkit may not support XML fallback as seamlessly as LangChain
   - **Mitigation**: Preserve XMLToolCallParser and integrate with Genkit's response handling
   - **Fallback**: Keep LangChain as optional dependency for legacy support

2. **Message Format Conversion**:

   - **Risk**: Subtle differences in message format could break conversations
   - **Mitigation**: Comprehensive unit tests for all message types and edge cases
   - **Fallback**: Detailed logging during conversion to catch issues

3. **Provider-Specific Quirks**:

   - **Risk**: OpenRouter, Ollama, or other providers may have specific requirements
   - **Mitigation**: Test with all supported providers in development
   - **Fallback**: Provider-specific handling in GenkitClient

4. **Network Configuration**:
   - **Risk**: Genkit may not provide same level of network control as undici
   - **Mitigation**: Continue using undici with Genkit if needed
   - **Fallback**: Custom fetch implementation in Genkit config

### Medium Risk Areas

1. **Performance**:

   - **Risk**: Genkit may be slower than LangChain
   - **Mitigation**: Benchmark both implementations
   - **Fallback**: Optimize Genkit configuration or revert

2. **JSON Schema to Zod Conversion**:
   - **Risk**: Complex schemas may not convert correctly
   - **Mitigation**: Extensive testing with real tool schemas
   - **Fallback**: Manual Zod schema definitions for problematic tools

### Low Risk Areas

1. **Error Handling**: Both frameworks use similar error patterns
2. **Model Selection**: Simple configuration change
3. **Context Size**: Same calculation logic applies

## Testing Strategy

### Unit Tests

1. **Message Conversion Tests**:

   - Test all message role conversions
   - Test messages with and without tool calls
   - Test edge cases (empty content, multiple tool calls)

2. **Tool Schema Conversion Tests**:

   - Test basic type conversions
   - Test nested objects and arrays
   - Test required/optional fields
   - Test all built-in tool schemas

3. **Error Handling Tests**:
   - Test API error parsing
   - Test network errors
   - Test cancellation
   - Test timeout errors

### Integration Tests

1. **Provider Tests**:

   - Test with Ollama (local)
   - Test with OpenRouter (hosted)
   - Test with custom OpenAI-compatible server

2. **Tool Calling Tests**:

   - Test native tool calling with supporting models
   - Test XML fallback with non-supporting models
   - Test parallel tool calls
   - Test tool call errors

3. **End-to-End Tests**:
   - Complete conversation with tool use
   - Model switching mid-conversation
   - Cancellation during generation
   - MCP server integration

## Rollback Plan

If critical issues are discovered:

1. **Immediate Rollback**:

   - Keep LangChain dependencies installed during migration
   - Use feature flag to switch between implementations
   - Can revert to LangChain in single commit

2. **Phased Rollback**:
   - Keep both implementations in codebase temporarily
   - Use environment variable to select implementation
   - Collect user feedback before full removal

## Timeline Estimate

- **Phase 1** (Setup): 1-2 hours
- **Phase 2** (GenkitClient): 8-12 hours
- **Phase 3** (Tool Schema Conversion): 4-6 hours
- **Phase 4** (Integration & Testing): 6-8 hours
- **Phase 5** (Cleanup): 2-3 hours

**Total Estimate**: 21-31 hours (3-4 development days)

## Success Metrics

1. **Functionality**: All features work identically to current implementation
2. **Performance**: Response time within 10% of current implementation
3. **Test Coverage**: All tests pass, coverage maintained or improved
4. **Code Quality**: Reduced lines of code, improved maintainability
5. **User Impact**: Zero breaking changes for end users

## Open Questions

1. Does Genkit support streaming? (Not required currently but may be future feature)
2. Can Genkit handle context length calculation for OpenRouter models?
3. Does Genkit support custom fetch implementations for undici?
4. How does Genkit handle rate limiting and retries?

## Dependencies

- Genkit documentation: https://genkit.dev/docs/
- OpenAI-compatible plugin: https://genkit.dev/docs/integrations/openai-compatible/
- Tool calling guide: https://genkit.dev/docs/tool-calling/

## Approval Required

- [ ] Review plan with maintainers
- [ ] Approve timeline and resource allocation
- [ ] Confirm risk mitigation strategies
- [ ] Approve testing strategy
