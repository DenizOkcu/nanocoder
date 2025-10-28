# LangGraph Migration Implementation Note

## Overview

Migrate from custom `ConversationStateManager` to LangGraph's built-in state management and persistence. This will leverage battle-tested agent orchestration patterns and reduce custom code maintenance.

## Current State

**File**: `source/app/utils/conversationState.ts:1-311`

Custom implementation tracking:

- Original task and progress
- Tool execution history
- Repetition detection
- Step estimation
- Next action suggestions

**Usage**: `source/hooks/useChatHandler.tsx:92`

```typescript
const conversationStateManager = React.useRef(new ConversationStateManager());
```

## LangGraph Features to Adopt

### 1. MessagesState (Core)

Built-in state management for conversation messages with automatic history tracking.

### 2. Checkpointing

Persistent state across sessions with multiple backend options:

- MemorySaver (in-memory, current session only)
- SqliteSaver (file-based, project-specific)
- PostgresSaver (shared across machines)

### 3. State Reducers

Custom state logic that runs on every message update.

### 4. Human-in-the-Loop

Built-in support for tool confirmation flows (matches Nanocoder's confirmation UX).

## Architecture Design

### State Schema

```typescript
import {Annotation} from '@langchain/langgraph';
import {BaseMessage} from '@langchain/core/messages';

// Define custom state beyond messages
const NanocoderState = Annotation.Root({
	// Built-in messages array
	messages: Annotation<BaseMessage[]>({
		reducer: (x, y) => x.concat(y),
	}),

	// Custom state fields
	originalTask: Annotation<string>(),
	currentStep: Annotation<number>(),
	totalEstimatedSteps: Annotation<number>(),
	completedActions: Annotation<string[]>({
		reducer: (x, y) => x.concat(y),
	}),
	toolCallsExecuted: Annotation<number>({
		reducer: (x, y) => x + y,
		default: () => 0,
	}),
	recentToolCalls: Annotation<ToolCall[]>({
		reducer: (x, y) => {
			const combined = x.concat(y);
			return combined.slice(-5); // Keep last 5
		},
		default: () => [],
	}),
	isRepeatingAction: Annotation<boolean>({
		default: () => false,
	}),
	conversationStartTime: Annotation<number>({
		default: () => Date.now(),
	}),
});
```

### Graph Structure

```typescript
import {StateGraph, START, END} from '@langchain/langgraph';

const workflow = new StateGraph(NanocoderState)
	// Nodes
	.addNode('agent', agentNode)
	.addNode('tools', toolsNode)
	.addNode('analyze_progress', analyzeProgressNode)

	// Edges
	.addEdge(START, 'agent')
	.addConditionalEdges('agent', shouldContinue, {
		tools: 'tools',
		end: END,
	})
	.addEdge('tools', 'analyze_progress')
	.addEdge('analyze_progress', 'agent');

// Compile with checkpointing
const checkpointer = new SqliteSaver('.nanocoder/checkpoints.db');
const app = workflow.compile({checkpointer});
```

### Node Implementations

```typescript
// Agent node - handles LLM calls
async function agentNode(state: typeof NanocoderState.State) {
	const messages = state.messages;
	const response = await llmClient.chat(messages, tools);

	return {
		messages: [response],
	};
}

// Tools node - executes tool calls
async function toolsNode(state: typeof NanocoderState.State) {
	const lastMessage = state.messages[state.messages.length - 1];
	const toolCalls = lastMessage.tool_calls || [];

	const toolResults = await Promise.all(
		toolCalls.map(async toolCall => {
			const result = await executeToolCall(toolCall);
			return new ToolMessage({
				content: result.content,
				tool_call_id: toolCall.id,
				name: toolCall.function.name,
			});
		}),
	);

	return {
		messages: toolResults,
		toolCallsExecuted: toolCalls.length,
		recentToolCalls: toolCalls,
		currentStep: 1, // Increment
	};
}

// Analyze progress node - detect repetition, update state
async function analyzeProgressNode(state: typeof NanocoderState.State) {
	const recentToolCalls = state.recentToolCalls;
	const isRepeating = detectRepetition(recentToolCalls);

	const completedActions = recentToolCalls.map(tc => describeToolAction(tc));

	return {
		isRepeating,
		completedActions,
	};
}

// Conditional edge - decide next step
function shouldContinue(state: typeof NanocoderState.State) {
	const lastMessage = state.messages[state.messages.length - 1];

	if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
		return 'tools';
	}

	return 'end';
}
```

## Integration with Nanocoder

### Replace ConversationStateManager

**File**: `source/hooks/useChatHandler.tsx`

**Before**:

```typescript
const conversationStateManager = React.useRef(new ConversationStateManager());
```

**After**:

```typescript
const [langGraphApp, setLangGraphApp] =
	React.useState<CompiledStateGraph | null>(null);
const [threadId, setThreadId] = React.useState<string>('default');

React.useEffect(() => {
	// Initialize LangGraph on mount
	const app = createNanocoderGraph(client, toolManager);
	setLangGraphApp(app);
}, [client, toolManager]);
```

### Invoke LangGraph Instead of Direct LLM Calls

**Before**:

```typescript
const response = await client.chat(
	updatedMessages,
	tools,
	abortController.signal,
);
```

**After**:

```typescript
const result = await langGraphApp.invoke(
	{
		messages: [new HumanMessage(userMessage)],
		originalTask: userMessage,
	},
	{
		configurable: {thread_id: threadId},
		signal: abortController.signal,
	},
);

// Extract messages from state
const responseMessages = result.messages;
```

### Thread Management for Multi-Project Support

```typescript
// Generate thread ID based on project directory
function getThreadId(): string {
	const cwd = process.cwd();
	const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
	return `project-${hash}`;
}

// Switch threads when changing directories
React.useEffect(
	() => {
		setThreadId(getThreadId());
	},
	[
		/* working directory */
	],
);
```

## Persistence Implementation

### SQLite Backend (Recommended)

```typescript
import {SqliteSaver} from '@langchain/langgraph-checkpoint-sqlite';

const checkpointer = await SqliteSaver.fromConnString(
	'.nanocoder/conversation-state.db',
);

const app = workflow.compile({
	checkpointer,
	interruptBefore: ['tools'], // Pause for tool confirmation
});
```

### File Structure

```
.nanocoder/
├── conversation-state.db     # SQLite database
├── commands/                 # Custom commands (existing)
└── implementation-notes/     # Implementation notes (existing)
```

### Cross-Session Resume

```typescript
// List all conversation threads for current project
const threads = await checkpointer.list({thread_id: threadId});

// Resume from specific checkpoint
const state = await langGraphApp.getState({
	configurable: {thread_id: threadId},
});

console.log(`Resuming conversation with ${state.messages.length} messages`);
```

## Human-in-the-Loop Integration

LangGraph natively supports pausing execution for human approval:

```typescript
const app = workflow.compile({
	checkpointer,
	interruptBefore: ['tools'], // Pause before tool execution
});

// Invoke until interruption
const result = await app.invoke(input, config);

// Check if interrupted
const state = await app.getState(config);
if (state.next.includes('tools')) {
	// Show tool confirmation UI
	const approved = await showToolConfirmation(state);

	if (approved) {
		// Resume execution
		const finalResult = await app.invoke(null, config);
	} else {
		// Cancel or modify
		await app.updateState(config, {messages: []});
	}
}
```

This replaces the custom `onStartToolConfirmationFlow` callback!

## Migration Strategy

### Phase 1: Parallel Implementation (Weeks 1-2)

- Create LangGraph implementation alongside existing code
- Feature flag: `USE_LANGGRAPH` environment variable
- Keep `ConversationStateManager` as fallback

### Phase 2: Testing & Validation (Week 3)

- Test with different models and workflows
- Verify state persistence across sessions
- Compare behavior with existing implementation
- Performance benchmarking

### Phase 3: Gradual Rollout (Week 4)

- Enable by default for new users
- Monitor for issues
- Provide opt-out for existing users

### Phase 4: Deprecation (Week 5+)

- Remove `ConversationStateManager`
- Clean up feature flag
- Update documentation

## Edge Cases & Considerations

### 1. Backward Compatibility

- Existing `.nanocoder/` structure should remain valid
- Don't break custom commands or MCP servers
- Migration path for users with custom hooks

### 2. Performance

- SQLite overhead vs in-memory state
- Checkpoint frequency (every message? every tool call?)
- Database size growth over time → cleanup old threads

### 3. Multi-User/Multi-Machine

- SQLite is single-machine only
- For shared state, consider PostgreSQL backend
- Cloud sync via `.nanocoder/` directory sync

### 4. Error Recovery

- Database corruption handling
- Reset conversation state command
- Export/import conversation history

### 5. Development Modes

- LangGraph must respect `developmentMode` setting
- Plan mode: don't execute tools, only suggest
- Auto-accept mode: skip human-in-the-loop interruptions

## Testing Strategy

### Unit Tests

```typescript
// Test state reducers
test('tool call history limited to 5', () => {
  const state = { recentToolCalls: [/* 5 existing */] };
  const newState = reducer(state, [/* 2 new */]);
  expect(newState.recentToolCalls.length).toBe(5);
});

// Test conditional edges
test('shouldContinue returns tools when tool_calls present', () => {
  const state = { messages: [new AIMessage({ tool_calls: [...] })] };
  expect(shouldContinue(state)).toBe('tools');
});
```

### Integration Tests

```typescript
test('conversation persists across sessions', async () => {
  const app = createNanocoderGraph();

  // First session
  await app.invoke({ messages: [...] }, { configurable: { thread_id: 'test' }});

  // Recreate app (simulate restart)
  const app2 = createNanocoderGraph();
  const state = await app2.getState({ configurable: { thread_id: 'test' }});

  expect(state.messages.length).toBeGreaterThan(0);
});
```

### Manual Tests

- [ ] Resume conversation after restarting CLI
- [ ] Tool confirmation flow works with interruption
- [ ] Multiple projects maintain separate conversation threads
- [ ] Repetition detection works as before
- [ ] Progress tracking accurate across sessions

## Configuration Options

Add to `nanocoder-preferences.json`:

```json
{
	"langgraph": {
		"enabled": true,
		"checkpointer": "sqlite", // "sqlite" | "memory" | "postgres"
		"checkpointFrequency": "every-message", // "every-message" | "after-tools"
		"maxHistoryMessages": 100, // Limit context size
		"persistenceLocation": ".nanocoder/conversation-state.db"
	}
}
```

## Benefits Over Custom Implementation

✅ **Battle-tested**: Used in production LangChain applications
✅ **Less maintenance**: No custom state management code
✅ **Built-in persistence**: Multiple backend options
✅ **Human-in-the-loop**: Native tool confirmation support
✅ **Debugging**: LangSmith integration for development
✅ **Extensibility**: Easy to add new nodes/edges
✅ **Community support**: Active development and documentation

## Risks & Mitigation

| Risk                               | Impact | Mitigation                                     |
| ---------------------------------- | ------ | ---------------------------------------------- |
| Breaking changes in LangGraph v1.0 | High   | Wait for stable release (Oct 2025)             |
| Performance regression             | Medium | Benchmark before/after, optimize checkpointing |
| Migration complexity               | Medium | Phased rollout with feature flag               |
| Learning curve for contributors    | Low    | Comprehensive documentation                    |
| Database corruption                | Low    | Automatic backups, reset command               |

## Resources

- [LangGraph Docs](https://langchain-ai.github.io/langgraphjs/)
- [State Management](https://langchain-ai.github.io/langgraphjs/concepts/low_level/#state)
- [Persistence](https://langchain-ai.github.io/langgraphjs/concepts/persistence/)
- [Human-in-the-Loop](https://langchain-ai.github.io/langgraphjs/concepts/human_in_the_loop/)

## Timeline

- **Research & Design**: 1 week (Oct 2025 after v1.0 release)
- **Implementation**: 2-3 weeks
- **Testing**: 1-2 weeks
- **Rollout**: 1 week
- **Total**: 5-7 weeks

## Success Criteria

- [ ] All existing ConversationStateManager features replicated
- [ ] Conversation persists across CLI restarts
- [ ] Tool confirmation flow works seamlessly
- [ ] No performance degradation (<10% overhead)
- [ ] Zero data loss during migration
- [ ] Documentation updated with LangGraph architecture
- [ ] Tests achieve >90% coverage of graph logic

## Open Questions

1. Should we support exporting conversation history as markdown/JSON?
2. How to handle database migrations when LangGraph updates?
3. Do we need conversation branching (multiple paths from same state)?
4. Should conversation history be prunable by user command?
5. Cloud sync strategy for `.nanocoder/` directory?

## Decision: Wait for LangGraph v1.0

**Recommendation**: Implement after LangGraph v1.0 release (October 2025)

**Rationale**:

- Breaking changes expected in v1.0
- Current implementation works well
- More stable API surface after v1.0
- Community patterns will emerge
- Better migration examples available
