# Component tree

Include the hooks, state, and module boundaries that matter. Name the file or package in parentheses where ownership is the point.

```tsx
<SessionPage> (apps/example/src/routes/session.tsx)
  useSessionEvents()
  <SessionToolbar>
    <RunSkillButton> (packages/ui)
```
