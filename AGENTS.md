<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Repository Agent Notes

This is a local-first Next.js project for generating project design documents.

## Development Rules

- Use TypeScript for all application code.
- Put project-domain logic in `src/lib/project`.
- Keep filesystem writes server-side only.
- Write tests before behavior changes.
- Run `npm run test` and `npm run lint` before claiming completion.
- Do not put generated project exports in git.
