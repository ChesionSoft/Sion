# Sion Chat Sessions Design

## Goal

Support multiple named chat sessions per workflow node, so users can save, revisit, and switch between conversation histories instead of losing them on node switch.

## Scope

- Per-node chat sessions with auto-naming
- Session list, switch, and create new session
- Auto-create session on entering a node
- Keep latest 10 sessions per node, auto-prune older ones
- Move model selector and file selector below the chat input area

Out of scope: session export, session rename, cross-node sessions, session search.

## Data Model

```ts
type ChatSession = {
  id: string;           // UUID
  nodeId: WorkflowNodeId;
  name: string;         // auto-generated, e.g. "6月14日 23:30"
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};
```

## Storage

```
projects/<projectId>/chat/<nodeId>/index.json       ← ChatSession[]
projects/<projectId>/chat/<nodeId>/<sessionId>.json  ← ChatMessage[]
```

Existing flat `chat/<nodeId>.json` files are no longer used. On first access, the store migrates: if a legacy `chat/<nodeId>.json` exists, its messages become the first session.

## API

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/projects/[projectId]/chat/sessions?nodeId=xx` | List sessions for a node |
| `DELETE` | `/api/projects/[projectId]/chat/sessions/[sessionId]` | Delete a session |
| `POST` | `/api/projects/[projectId]/chat` | Existing, add optional `sessionId` body param |

Chat POST behavior:
- If `sessionId` provided: append to that session
- If `sessionId` omitted: auto-create a new session, append to it
- Response includes `sessionId` so the frontend can track the current session

## Store Changes

Extend `ProjectStore` with session methods:

- `createSession(projectId, nodeId)` — create session with auto-generated name from current time, prune to 10
- `listSessions(projectId, nodeId)` — return sessions sorted by createdAt desc
- `getChatMessages(projectId, nodeId, sessionId)` — read messages for a session
- `appendChatMessage(projectId, nodeId, sessionId, message)` — append and update session's messageCount/updatedAt
- `deleteSession(projectId, sessionId)` — delete session file and remove from index

Existing `getChatMessages` and `appendChatMessage` gain an optional `sessionId` parameter.

## UI Changes

### ChatPanel layout (top to bottom)

1. Header: node name + session selector dropdown + new session button
2. Message list (scrollable, fills remaining space)
3. Text input + send button
4. Model selector (provider + model dropdowns)
5. File selector (chips from project file pool)

### Session selector behavior

- On mount: fetch sessions for current node, auto-create a new session, set as active
- Dropdown shows session names with message count
- Selecting a past session loads its messages
- "+" button creates another new session
- Switching nodes resets the session list for the new node

### 10-session limit

Enforced server-side in `createSession`. When creating exceeds 10, the oldest session (by createdAt) is deleted along with its message file. No user-facing warning needed.

## Error Handling

- Missing sessionId in chat POST → auto-create, not an error
- Invalid sessionId → 404 "会话不存在"
- Delete non-existent session → 404

## Testing

- Store: create, list, prune, append, delete sessions
- API: GET sessions, DELETE session, POST chat with/without sessionId
- UI: session dropdown renders, switching sessions loads messages, new session button works
- Legacy migration: old flat chat file becomes first session

## Implementation Order

1. Add ChatSession type and extend ProjectStore with session methods
2. Add GET/DELETE session API routes
3. Update chat POST route to accept sessionId
4. Update ChatPanel UI: session selector, new session button, move model/file selectors below input
5. Run tests and browser verification
