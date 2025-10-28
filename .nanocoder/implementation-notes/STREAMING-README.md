# Nanocoder Streaming Implementation Guide

## Quick Overview

**Current State**: Nanocoder does NOT implement token streaming. It waits for complete LLM responses before displaying them to the user.

**Goal**: Implement real-time token streaming with intelligent batching to provide responsive, progressive feedback.

---

## Documentation Files

### 1. Start Here: `streaming-with-token-batching.md`

**What**: Complete, ready-to-implement plan for token batching
**Size**: 22 KB
**Contains**:
- Motivation and benefits
- LangChain v1.0 streaming API options
- Detailed implementation phases (7 phases)
- Configuration examples
- Testing strategy
- Edge cases handling
- Estimated effort: 12-16 hours

**Key Sections**:
- Phase 1: Add streaming configuration
- Phase 2: Update LLMClient interface
- Phase 3: Implement token batching in LangGraphClient
- Phase 4: Add streaming state to chat handler
- Phase 5: Create StreamingMessage component
- Phase 6: Integrate into App component
- Phase 7: Handle tool calls during streaming

**Recommended Action**: Read this first for implementation details.

---

### 2. Deep Dive: `streaming-architecture-analysis.md`

**What**: Comprehensive analysis of current architecture and proposed changes
**Size**: 20 KB
**Contains**:
- Current streaming flow (non-streaming architecture)
- LLM client implementation details
- Message handling & state management
- Token processing architecture
- UI rendering patterns
- Performance bottlenecks & pain points
- Implementation roadmap
- Success criteria
- LangChain v1.0 streaming APIs comparison

**Key Insights**:
- How `.invoke()` waits for complete response
- Why `Static` component prevents terminal flicker
- Where token batching logic fits
- Dual-threshold batching algorithm
- 10x reduction in re-renders (100 tokens → 10 renders)

**Recommended Action**: Read after implementation plan for architectural understanding.

---

### 3. Visual Reference: `streaming-architecture-diagram.md`

**What**: ASCII diagrams and visual flows
**Size**: 30 KB
**Contains**:
- High-level component architecture
- Current flow (wait-for-complete-response)
- Proposed flow (with token batching)
- State machine lifecycle
- Component rendering flow
- Data flow during streaming
- Performance comparison before/after

**Key Diagrams**:
- Component dependency tree
- Request flow with annotations
- State transitions during streaming
- Memory/performance improvements

**Recommended Action**: Use when visualizing the flow or explaining to others.

---

### 4. Reference: `streaming-support.md`

**What**: Initial streaming design overview
**Size**: 8.2 KB
**Contains**:
- Overview of LangChain streaming APIs
- Option 1: Callbacks (simpler)
- Option 2: streamEvents() (more flexible)
- Initial implementation ideas
- Edge cases & considerations
- Testing strategy
- Configuration options
- Migration path
- References

**Recommended Action**: Use as alternative reference if token batching plan doesn't cover your needs.

---

### 5. Future Reference: `langgraph-migration.md`

**What**: Plan for future LangGraph integration
**Size**: 22 KB
**Note**: This is NOT related to streaming. It's a separate architectural migration.

**Contains**:
- State management with LangGraph
- Checkpointing and persistence
- Human-in-the-loop integration
- Multi-project conversation threads

**Recommended Action**: File for later (LangGraph v1.0 migration effort, separate from streaming).

---

## Implementation Path

### Quick Start (2-3 hours for experienced developers)

1. Read: `streaming-with-token-batching.md` Phase 1-2
2. Modify: `source/types/core.ts` - Add `onToken` callback
3. Modify: `source/langgraph-client.ts` - Implement batching
4. Test: Verify token batching works

### Complete Implementation (10-13 hours)

Follow all 7 phases in `streaming-with-token-batching.md`:
1. Configuration setup
2. Interface updates
3. Token batching logic
4. Streaming state management
5. UI component
6. App integration
7. Tool call handling

### Testing & Validation (3-4 hours)

1. Unit tests for token batching
2. Integration tests with streaming + tools
3. Manual testing across providers (OpenRouter, Ollama, OpenAI)
4. Performance benchmarking

---

## Key Architecture Points

### The Streaming Challenge

Nanocoder uses Ink's `Static` component to prevent terminal flickering:
- All messages are immediately made static
- Static components can't be updated after rendering
- Streaming requires frequent updates

### The Solution: Token Batching

**Dual-Threshold Approach**:
- Flush tokens when **10 accumulated** (count threshold)
- OR flush tokens when **75ms elapsed** (time threshold)

**Result**:
- ~13 FPS smooth animation
- 100 tokens → 10 re-renders (not 100)
- No terminal flickering

### Implementation Strategy

```
StreamingMessage (NEW):
• Outside Static component
• Re-renders for each batch (~10-15 times)
• Shows content as it arrives

AssistantMessage (existing):
• In Static component
• No re-renders after first render
• Used after streaming completes
```

---

## Files to Modify

**Core Implementation**:
- `source/types/core.ts` - Add `onToken` callback parameter
- `source/langgraph-client.ts` - Implement token batching
- `source/hooks/useChatHandler.tsx` - Add streaming state & callback
- `source/components/streaming-message.tsx` **(NEW)** - Streaming UI
- `source/app.tsx` - Integrate streaming component

**Configuration**:
- `source/types/config.ts` - Add `streaming` boolean to provider config

**Testing**:
- `source/langgraph-client.spec.ts` - Token batching unit tests
- `source/components/__tests__/streaming-message.spec.tsx` - Component tests

---

## Performance Impact

### Before Streaming

```
0s           5s           10s
|____________|____________|
[Spinner]    [Complete Response]

User experience: Long wait with no feedback
```

### After Streaming

```
0s  0.2s  0.4s  0.6s  0.8s
|____|____|____|____|
Content updates every 75-100ms
Smooth, responsive, progressive

User experience: Immediate feedback, engaging
```

---

## Success Criteria

From `streaming-with-token-batching.md`:

- [x] Understand current architecture ✓ (This document!)
- [ ] Tokens display in real-time (<100ms latency)
- [ ] Token batching reduces re-renders to 10-15 per response
- [ ] No terminal flickering (Static messages remain stable)
- [ ] Per-provider streaming configuration works
- [ ] Cancellation works cleanly mid-stream
- [ ] Tool calls detected correctly after streaming
- [ ] All existing tests pass

---

## Additional Resources

**LangChain Documentation**:
- [Streaming Concepts](https://js.langchain.com/docs/concepts/streaming/)
- [How to Stream Responses](https://js.langchain.com/docs/how_to/streaming_llm/)
- [ChatOpenAI Streaming](https://js.langchain.com/docs/how_to/chat_streaming/)

**Ink Documentation**:
- [Ink Static Component](https://github.com/vadimdemedes/ink#static)

**Nanocoder Documentation**:
- See `CLAUDE.md` in project root for architecture overview
- Existing implementation notes in this directory

---

## Questions?

Refer to the specific documentation:

- **"How do I implement this?"** → `streaming-with-token-batching.md`
- **"Why is it designed this way?"** → `streaming-architecture-analysis.md`
- **"Can you show me a diagram?"** → `streaming-architecture-diagram.md`
- **"What are the alternatives?"** → `streaming-support.md`
- **"What about LangGraph?"** → `langgraph-migration.md` (separate feature)

---

## Timeline

- **Research & Planning**: ✓ Complete (see documentation)
- **Phase 1-3 (Core)**: 2-3 hours
- **Phase 4-6 (UI)**: 2 hours
- **Phase 7 (Tools)**: 1-2 hours
- **Testing**: 3-4 hours
- **Total**: 10-13 hours

---

## Last Updated

October 28, 2025

Analysis includes investigation of:
- Current LLM client implementation
- Message handling architecture
- UI rendering with Ink's Static component
- Token processing flow
- Performance optimization opportunities
- LangChain v1.0 API capabilities

