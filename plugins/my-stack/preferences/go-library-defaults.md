---
way: my-go-way
description: Scott's preferences when choosing libraries or tools for Go code.
---

# Go library defaults

When the project leaves the choice open, prefer `zerolog` for logging,
`envconfig` for environment configuration, `goccy/go-json` imported as `json`,
`go-playground/validator` for input validation, and `stretchr/testify` for
assertions. Prefer `gotestsum` and `golangci-lint` when choosing test and lint
tools.

Apply these defaults to choices already in scope. Do not migrate dependencies
during a small fix or replace an established project convention just to match
these preferences.
