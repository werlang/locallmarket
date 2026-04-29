# Patterns

- In compose development, each worker replica needs its own mounted `/app/node_modules` volume plus package-lock-aware dependency hydration to avoid stale shared dependencies and cross-replica install races.
- Integration tests that need the API HTTP server use `process.env.PORT = '0'` and `process.env.API_WS_PORT = '0'` before importing `api/app.js` to get OS-assigned ports. The exported `server` reference is used for cleanup (`server.close()`).
- Worker unit tests isolate network with `FakeSocket` and `FakeWSServer` classes defined inline. API client tests use a minimal fake `WebSocket` with `.send()` and `.readyState` properties. LLM tests mock `global.fetch`.
- Named exports only: all classes use `export class Foo {}` — never `export default`. Test files must use `import { Foo } from ...` not `import Foo from ...`.
