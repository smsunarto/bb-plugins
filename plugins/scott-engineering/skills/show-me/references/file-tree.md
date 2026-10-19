# File tree

Keep it shallow. One comment per entry names its responsibility. Use a `diagram` fence: bb Monokai tightens its leading so the box-drawing connectors join.

```diagram
src/
├── commands/       # parses user actions
├── sessions/       # owns session state
└── transport/      # sends API requests
```
