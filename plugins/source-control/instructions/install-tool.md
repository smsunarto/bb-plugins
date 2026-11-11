Source Control could not read the checkout {{path}} on this machine: `{{tool}}` is not installed here, or not on the PATH bb runs commands with.

```
{{detail}}
```

Install `{{tool}}` ({{toolName}}) on this machine so commands bb runs can find it:

- Check first whether it is installed but missing from the PATH: `command -v {{tool}}`, then look in the usual install locations.
- Install it with the machine's package manager or the tool's official installer. Ask before anything that needs a password or changes system-wide settings.
- Do not change the checkout's branches or files.

When `{{tool}} --version` works from a new login shell, say so in one line. Source Control reads the checkout again when the user presses Try again.
