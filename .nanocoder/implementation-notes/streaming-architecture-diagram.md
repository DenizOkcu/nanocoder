# Nanocoder Streaming Architecture Diagrams

## High-Level Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      NANOCODER APPLICATION                      │
└─────────────────────────────────────────────────────────────────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
                ▼                ▼                ▼
        ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
        │  useAppState │  │useChatHandler│  │ useToolHandler
        │   (State)    │  │ (Chat Logic) │  │(Tool Confirm)
        └──────────────┘  └──────────────┘  └──────────────┘
                │                │                │
                └────────────────┼────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │ LangGraphClient │
                        │   (LLM Client)  │
                        └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
            ┌─────────────────┐      ┌──────────────────┐
            │ LangChain v1.0  │      │ Token Batching   │
            │  ChatOpenAI     │      │ (NEW - Proposed) │
            └─────────────────┘      └──────────────────┘
                    │                         │
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │  Message + Tool Calls  │
                    │ (Complete Response)    │
                    └────────────┬───────────┘
                                 │
                ┌────────────────┴────────────────┐
                │                                 │
                ▼                                 ▼
        ┌──────────────────┐          ┌─────────────────────┐
        │AssistantMessage  │          │StreamingMessage (NEW)
        │   (Complete)     │          │  (During Streaming)
        └──────────────────┘          └─────────────────────┘
                │                                 │
                │                                 │
                ▼                                 ▼
        ┌──────────────────┐          ┌─────────────────────┐
        │ ChatQueue.Static │          │ Streaming Area      │
        │ (No Re-renders)  │          │ (Live Updates)      │
        └──────────────────┘          └─────────────────────┘
```

---

## Current Flow: Wait-for-Complete-Response

```
┌────────────────────────────────────────────────────────────────┐
│                     USER SUBMITS MESSAGE                        │
└────────────────┬───────────────────────────────────────────────┘
                 │
                 ▼
         ┌──────────────────┐
         │ handleChatMessage│
         │  (useChatHandler)│
         └────────┬─────────┘
                  │
                  ▼
         ┌─────────────────────────┐
         │ Display UserMessage     │
         │ (Shown immediately)     │
         └─────────────┬───────────┘
                       │
                       ▼
         ┌─────────────────────────────┐
         │ setIsThinking(true)         │
         │ Show spinning indicator     │
         └─────────────┬───────────────┘
                       │
                       ▼
    ┌──────────────────────────────────────────┐
    │ LangGraphClient.chat()                   │
    │ ┌──────────────────────────────────────┐ │
    │ │ await chatModel.invoke(messages)     │ │
    │ │                                      │ │
    │ │ LangChain internally:                │ │
    │ │ • Streams tokens from LLM            │ │
    │ │ • Accumulates complete response      │ │
    │ │ • NO callbacks to expose tokens      │ │
    │ │                                      │ │
    │ │ ⏳ WAITING... (User sees spinner)    │ │
    │ │                                      │ │
    │ │ Result received (complete text)      │ │
    │ └──────────────────────────────────────┘ │
    │                                          │
    │ • Parse XML tool calls (if any)         │
    │ • Check for native tool calls           │
    │ • Return complete response              │
    └────────┬─────────────────────────────────┘
             │
             ▼
    ┌────────────────────────────────┐
    │ setIsThinking(false)           │
    │ Remove spinner                 │
    └────────┬───────────────────────┘
             │
             ▼
    ┌────────────────────────────────┐
    │ addToChatQueue()               │
    │ AssistantMessage component     │
    │ (Complete text at once)        │
    └────────┬───────────────────────┘
             │
             ▼
    ┌────────────────────────────────┐
    │ App State Update               │
    │ chatComponents push new comp   │
    └────────┬───────────────────────┘
             │
             ▼
    ┌────────────────────────────────┐
    │ ChatQueue Re-renders           │
    │ Displays AssistantMessage      │
    │ (Makes it Static immediately)  │
    └────────────────────────────────┘
             │
             ▼
    ┌────────────────────────────────┐
    │ Check for tool calls           │
    │ • If present → confirm flow    │
    │ • If absent → done            │
    └────────────────────────────────┘

PROBLEM: User waits entire time to see response!
Response might be 100+ tokens but no visibility.
```

---

## Proposed Flow: Token Streaming with Batching

```
┌────────────────────────────────────────────────────────────────┐
│                     USER SUBMITS MESSAGE                        │
└────────────────┬───────────────────────────────────────────────┘
                 │
                 ▼
         ┌──────────────────┐
         │ handleChatMessage│
         │  (useChatHandler)│
         └────────┬─────────┘
                  │
                  ▼
         ┌─────────────────────────┐
         │ Display UserMessage     │
         │ (Shown immediately)     │
         └─────────────┬───────────┘
                       │
                       ▼
         ┌─────────────────────────────┐
         │ setIsThinking(true)         │
         │ Show spinning indicator     │
         └─────────────┬───────────────┘
                       │
                       ▼
    ┌──────────────────────────────────────────────────────────┐
    │ LangGraphClient.chat(                                     │
    │   messages,                                              │
    │   tools,                                                 │
    │   signal,                                                │
    │   onToken: (batchedTokens) => {...}  ◄── NEW CALLBACK   │
    │ )                                                        │
    │                                                          │
    │ ┌──────────────────────────────────────────────────────┐│
    │ │ LangChain ChatOpenAI.invoke()                        ││
    │ │ with callbacks: [{ handleLLMNewToken }]  ◄── NEW    ││
    │ │                                                      ││
    │ │ Token stream from LLM:                              ││
    │ │ "Hello", " ", "world", "!", ...                     ││
    │ │     │       │      │     │                           ││
    │ │     ▼       ▼      ▼     ▼                           ││
    │ │ ┌────────────────────────────────┐                  ││
    │ │ │ Token Batching Buffer         │                  ││
    │ │ │ buffer = ''                   │                  ││
    │ │ │ count = 0                     │                  ││
    │ │ │ lastEmit = Date.now()         │                  ││
    │ │ │ BATCH_SIZE = 10               │                  ││
    │ │ │ BATCH_INTERVAL_MS = 75ms      │                  ││
    │ │ └────────────────────────────────┘                  ││
    │ │              │                                      ││
    │ │  ┌───────────┴───────────┐                          ││
    │ │  ▼                       ▼                          ││
    │ │ Batch 1:                Batch 2:                   ││
    │ │ "Hello world" (10)      " that's cool" (8)         ││
    │ │ onToken sent            onToken sent               ││
    │ └──────────────────────────────────────────────────────┘│
    │                                                          │
    │ Result received (complete response + batched tokens)    │
    └────────┬─────────────────────────────────────────────────┘
             │
    ┌────────┴─────────────────────────────┐
    │                                       │
    ▼                                       ▼
┌──────────────────────────┐     ┌────────────────────────────┐
│ setIsThinking(true)      │     │ setStreamingContent(...)   │
│ setIsStreaming(true)     │     │ Display StreamingMessage   │
│                          │     │ (Outside Static)           │
└──────┬───────────────────┘     └────────┬───────────────────┘
       │                                   │
       │         ┌─────────────────────────┘
       │         │
       ▼         ▼
    ┌──────────────────────────────┐
    │ App State:                   │
    │ • streamingContent updated   │
    │ • isStreaming = true         │
    │ • isThinking = false         │
    └──────────┬───────────────────┘
               │
               ▼
    ┌────────────────────────────────────────┐
    │ StreamingMessage Component (NEW)       │
    │ (Re-renders for each batch: ~10-15x)   │
    │                                        │
    │ Shows:                                 │
    │ • Accumulated content                 │
    │ • Blinking cursor while streaming     │
    │ • Markdown formatted                  │
    │                                        │
    │ ✓ NOT in Static (allows updates)      │
    │ ✓ Positioned OUTSIDE ChatQueue.Static │
    └────────┬───────────────────────────────┘
             │
             ▼
    ┌────────────────────────────────────────┐
    │ Terminal Display Updates:              │
    │                                        │
    │ [Static Messages Above]                │
    │                                        │
    │ Claude 3.5:                           │
    │ Hello world that's cool and... ▊       │
    │ (updates smoothly, no flicker)        │
    │                                        │
    │ [Thinking still visible]              │
    └─────────────┬──────────────────────────┘
                  │
        ┌─────────┴──────────┐
        │ Streaming ends     │
        │ (complete response)│
        └─────────┬──────────┘
                  │
                  ▼
    ┌────────────────────────────────┐
    │ setIsStreaming(false)          │
    │ setStreamingContent('')        │
    │ setIsThinking(false)           │
    └────────┬───────────────────────┘
             │
             ▼
    ┌────────────────────────────────┐
    │ Parse tool calls               │
    │ Move to AssistantMessage       │
    │ Add to Static ChatQueue        │
    └────────┬───────────────────────┘
             │
             ▼
    ┌────────────────────────────────┐
    │ Check tool calls               │
    │ • If present → confirm         │
    │ • If absent → done            │
    └────────────────────────────────┘

BENEFIT: User sees content appearing in real-time!
Smooth streaming with ~13 FPS updates (no flicker).
```

---

## State Machine: Streaming Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    STREAMING STATE MACHINE                   │
└─────────────────────────────────────────────────────────────┘

    ┌─────────────────────────────────────────┐
    │         IDLE / WAITING FOR INPUT        │
    │                                         │
    │ isThinking: false                       │
    │ isStreaming: false                      │
    │ streamingContent: ''                    │
    └────────────────┬────────────────────────┘
                     │
           User sends message
                     │
                     ▼
    ┌─────────────────────────────────────────┐
    │        THINKING (No Stream Yet)         │
    │                                         │
    │ isThinking: true        ◄─────┐         │
    │ isStreaming: false             │        │
    │ streamingContent: ''           │        │
    │                                │        │
    │ Display: Spinner/Thinking      │        │
    │          indicator             │        │
    └────────────────┬────────────────┼───────┘
                     │                │
        ┌────────────┴────────┐       │
        │ (LLM processing)    │       │
        ▼                     ▼       │
    ┌──────────────────────────────┐ │
    │ No Streaming Available       │ │ Streaming Error
    │ (Fallback: wait for all)     ├─┼───────────────┐
    │                              │ │                │
    │ isThinking: true            │ │                │
    │ isStreaming: false          │ │                │
    │                              │ │                │
    │ [Wait for complete]          │ │                │
    │                              │ │                │
    │ Display: Spinner             │ │                ▼
    └────────────┬─────────────────┘ │         ┌──────────────┐
                 │                   │         │    ERROR    │
                 │                   │         │   STATE     │
                 │                   │         └──────┬───────┘
                 │                   │                │
                 │                   └────────────────┘
                 │
        First token received
                 │
                 ▼
    ┌──────────────────────────────────────┐
    │      STREAMING IN PROGRESS           │
    │                                      │
    │ isThinking: false                    │
    │ isStreaming: true        ◄────┐      │
    │ streamingContent: '...'         │    │
    │                                │    │
    │ Display: StreamingMessage       │    │
    │          with cursor (▊)        │    │
    │          blinking               │    │
    │                                │    │
    │ Terminal shows content as it    │    │
    │ accumulates in real-time        │    │
    │                                │    │
    │ User can Ctrl+C to cancel ─────┼───┐│
    │                                │   ││
    └────────────┬───────────────────┘   ││
                 │                       ││
        Last batch flushed
        (Response complete)              ││
                 │                       ││
                 ▼                       ││
    ┌──────────────────────────────────┐ ││
    │   STREAMING COMPLETE              │ ││
    │                                   │ ││
    │ isThinking: false                 │ ││
    │ isStreaming: false                │ ││
    │ streamingContent: '' (cleared)    │ ││
    │                                   │ ││
    │ • Parse tool calls                │ ││
    │ • Move to Static ChatQueue        │ ││
    │ • Parse markdown                  │ ││
    │ • Format final message            │ ││
    │                                   │ ││
    │ Display: Final AssistantMessage   │ ││
    │          (in Static area)         │ ││
    └────────────┬────────────────────┘ ││
                 │                      ││
        ┌────────┴──────────┐          ││
        │                   │          ││
        ▼                   ▼          ││
    ┌─────────────┐   ┌──────────────┐ ││
    │ Tool Calls? │   │  Cancelled   │◄┘│
    │ • Yes       │   │   (Ctrl+C)   │  │
    │   → Confirm │   │              │  │
    │ • No        │   │ Partial text │  │
    │   → Done    │   │ displayed    │  │
    └─────────────┘   │              │  │
                      │ Can retry or │  │
                      │ continue     │  │
                      └──────┬───────┘  │
                             │          │
                             ▼          │
                      ┌──────────────┐  │
                      │  IDLE        │◄─┘
                      │  WAITING FOR │
                      │  NEXT INPUT  │
                      └──────────────┘
```

---

## Component Rendering Flow

```
┌────────────────────────────────────────────────┐
│              App Component Render              │
└────────────┬─────────────────────────────────┘
             │
             ▼
┌────────────────────────────────────────────────┐
│              App.tsx Structure                 │
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │ ThemeContext.Provider                    │ │
│  │ └──────────────────────────────────────┐ │ │
│  │   │ UIStateProvider                     │ │ │
│  │   │ └────────────────────────────────┐  │ │ │
│  │   │   │ Box (main layout)            │  │ │ │
│  │   │   │                              │  │ │ │
│  │   │   ├── Box (flexGrow=1)           │  │ │ │
│  │   │   │   ├── ChatQueue              │  │ │ │
│  │   │   │   │   ├── Static             │  │ │ │
│  │   │   │   │   │   └── Past Messages  │  │ │ │
│  │   │   │   │   └── No re-renders      │  │ │ │
│  │   │   │   │                          │  │ │ │
│  │   │   │   └── StreamingMessage (NEW) │  │ │ │
│  │   │   │       (Outside Static)       │  │ │ │
│  │   │   │       (Re-renders during)    │  │ │ │
│  │   │   │                              │  │ │ │
│  │   │   ├── ThinkingIndicator          │  │ │ │
│  │   │   │   (When isThinking=true)     │  │ │ │
│  │   │   │                              │  │ │ │
│  │   │   ├── ModelSelector              │  │ │ │
│  │   │   ├── ProviderSelector           │  │ │ │
│  │   │   ├── ToolConfirmation           │  │ │ │
│  │   │   │   (When tools need approval) │  │ │ │
│  │   │   │                              │  │ │ │
│  │   │   └── UserInput                  │  │ │ │
│  │   │       (Disabled during thinking) │  │ │ │
│  │   │                                  │  │ │ │
│  │   └────────────────────────────────┘  │ │ │
│  │                                        │ │ │
│  └──────────────────────────────────────┘ │ │
│                                            │ │
└────────────────────────────────────────────┘

Key Insight:
• ChatQueue.Static: Never re-renders (immutable)
• StreamingMessage: OUTSIDE Static, re-renders with batches
• Once streaming completes, moves to Static
• Static component prevents terminal flicker
```

---

## Data Flow During Streaming

```
LLM Response Generation
│
├─ Token 1: "Hello"
├─ Token 2: " "
├─ Token 3: "world"
├─ Token 4: "!"
├─ Token 5: " "
├─ Token 6: "How"
├─ Token 7: " "
├─ Token 8: "can"
├─ Token 9: " "
├─ Token 10: "I"
│   │
│   ▼ (10 tokens accumulated)
│   onToken: "Hello world! How can I"
│   ▼
│   useChatHandler receives batch
│   setStreamingContent(prev => prev + "Hello world! How can I")
│
├─ Token 11: " help"
├─ Token 12: " "
├─ Token 13: "you"
├─ Token 14: "?"
├─ Token 15: (pause)
│   │
│   ▼ (75ms elapsed or more tokens)
│   onToken: " help you?"
│   ▼
│   useChatHandler receives batch
│   setStreamingContent(prev => prev + " help you?")
│
└─ (End of stream)
   │
   ▼ Final onToken call (flush remaining)
   
   Final streamingContent: "Hello world! How can I help you?"
```

---

## Performance Comparison

### Before Streaming (Current)

```
User Input
    │
    ▼
[Spinner 1-5 seconds]  ◄─ User sees nothing
    │
    ▼
[Full response appears instantly]
    │
    ▼
Display + parse markdown
    │
    ▼
Ready

Timeline:
0s ─── 5s ──────────────────────────────────────────────────
      [Thinking]          [Complete response]
      
User experience: Long wait, then sudden response
```

### After Streaming (Proposed)

```
User Input
    │
    ▼
[Spinner + start streaming]
    │
    ├─ 0.2s: "Hello world..."
    │
    ├─ 0.3s: "Hello world! How can"
    │
    ├─ 0.4s: "Hello world! How can I help"
    │
    ├─ 0.5s: "Hello world! How can I help you?"
    │
    └─ [Streaming complete, parse tools]
    │
    ▼
Ready

Timeline:
0s ─ 0.1s ─ 0.2s ─ 0.3s ─ 0.4s ─ 0.5s
│    │      │      │      │      │
└─────── Visible progress throughout ─────────

User experience: Immediate feedback, smooth streaming
```

---

## References

- **Architectural Decision**: Use token batching with `Static` component constraints
- **Implementation Guide**: See `streaming-with-token-batching.md`
- **Current Non-Streaming Flow**: Lines 290-392 in `langgraph-client.ts`
- **Message Display**: `components/chat-queue.tsx` (Static rendering)
