# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Code Style

Use comments sparingly. Only comment complex or non-obvious logic.

## Commands

```bash
# First-time setup
npm run setup          # install + prisma generate + migrate

# Development
npm run dev            # Next.js dev server with Turbopack on http://localhost:3000
npm run dev:daemon     # Same, background, logs → logs.txt

# Testing
npm run test           # Run all Vitest tests (watch mode)
npm run test -- --run src/lib/__tests__/file-system.test.ts  # Single test file
npm run test -- --run --reporter=verbose -t "createSession"  # Single test by name

# Database
npm run db:reset       # Drop and recreate database (destructive)
npx prisma studio      # Open Prisma GUI

# Lint / build
npm run lint
npm run build
```

Tests run in jsdom via Vitest. Path aliases (`@/`) are resolved by `vite-tsconfig-paths` in `vitest.config.mts`. The `NODE_OPTIONS='--require ./node-compat.cjs'` prefix in dev/build commands patches Node.js compatibility shims needed by Next.js 15 + Turbopack.

## Architecture

### Request / data flow

Each chat turn is **stateless on the server**. The client serializes the entire `VirtualFileSystem` to JSON and sends it with every POST to `/api/chat`. The server reconstructs the VFS, runs `streamText` with up to 40 agentic steps, and streams tool calls back. The client applies those tool calls live via `FileSystemContext.handleToolCall`.

```
User message
  → ChatContext (useAIChat) serializes VFS + sends POST /api/chat
      → route.ts: deserializes VFS, calls streamText with tools
          → Claude streams tool calls (str_replace_editor / file_manager)
      → onToolCall: FileSystemContext mutates in-memory VFS
      → onFinish: if projectId + authed → saves messages + VFS to Prisma
  → refreshTrigger increment → PreviewFrame re-renders
```

### Virtual File System (`src/lib/file-system.ts`)

`VirtualFileSystem` is an in-memory tree of `FileNode` objects stored in a flat `Map<path, FileNode>`. Nothing is ever written to disk. It is:
- **Serialized** as `Record<string, FileNode>` (plain objects, no Maps) for JSON transfer
- **Reconstructed** server-side in every API request via `deserializeFromNodes`
- **Held in React state** client-side inside `FileSystemProvider`

`VirtualFileSystem` also implements the text-editor primitives (`replaceInFile`, `insertInFile`, `viewFile`, `createFileWithParents`) that back the AI tools.

### AI tools

Two tools are registered in `route.ts`:
- **`str_replace_editor`** (`src/lib/tools/str-replace.ts`) — create/str_replace/insert/view operations on the VFS
- **`file_manager`** (`src/lib/tools/file-manager.ts`) — rename/delete operations

The generation system prompt is in `src/lib/prompts/generation.tsx` and uses Anthropic prompt caching (`cacheControl: ephemeral`).

### Preview pipeline (`src/lib/transform/jsx-transformer.ts`)

When the VFS changes, `PreviewFrame` calls `createImportMap(files)`, which:
1. Transforms every `.jsx/.tsx/.ts/.js` file with **Babel standalone** (in-browser)
2. Creates **blob URLs** for each transformed module
3. Builds a native ES import map (including `@/` alias support)
4. Resolves third-party imports via `https://esm.sh/`
5. Injects everything into an `<iframe srcdoc>` with Tailwind CDN

Entry point resolution order: `/App.jsx` → `/App.tsx` → `/index.jsx` → `/index.tsx` → `/src/App.*` → first `.jsx/.tsx` found.

### Provider / mock mode (`src/lib/provider.ts`)

`getLanguageModel()` returns `anthropic("claude-haiku-4-5")` when `ANTHROPIC_API_KEY` is set, otherwise a `MockLanguageModel` that streams pre-built component code. The mock uses `maxSteps: 4`; real usage allows up to `maxSteps: 40`.

### Auth (`src/lib/auth.ts`)

JWT-based, server-only (`import "server-only"`). Sessions stored as HttpOnly cookies (`auth-token`), 7-day expiry, signed with `JWT_SECRET` env var (defaults to `"development-secret-key"`). Users can work anonymously — anonymous work is tracked in `src/lib/anon-work-tracker.ts` and persisted to `localStorage` so it can be claimed on sign-up.

### Database

Prisma + SQLite (`prisma/dev.db`). Two models: `User` and `Project`. `Project.messages` and `Project.data` are JSON-stringified blobs. Prisma client is generated to `src/generated/prisma` (not the default location — see `prisma/schema.prisma`).

### Context providers

`FileSystemProvider` wraps `ChatProvider` (chat depends on the file system). Both are client components. `FileSystemContext` exposes `handleToolCall` which is wired directly to `useAIChat`'s `onToolCall` callback.
