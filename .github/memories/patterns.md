# Patterns

- In compose development, each worker replica needs its own mounted `/app/node_modules` volume plus package-lock-aware dependency hydration to avoid stale shared dependencies and cross-replica install races.
