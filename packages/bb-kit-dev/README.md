# @bb-kit/dev

Development tooling for [@bb-kit/core](../bb-kit-core) plugins. Installs the
`bb-kit` binary.

```sh
npx @bb-kit/dev create my-plugin
cd my-plugin
npm test
```

| Command                                            | Does                                                |
| -------------------------------------------------- | --------------------------------------------------- |
| `bb-kit create <name>`                             | Scaffold a working plugin with UI and passing tests |
| `bb-kit add query\|mutation\|command\|tool <name>` | Write one unit and its test, print the wiring lines |
| `bb-kit check`                                     | Verify file names, keys, and wiring match           |

## Build, watch, and test

Use BB's own plugin commands for the live development loop:

```sh
bb plugin build .
bb plugin install .
bb plugin dev .
```

Use `@get-bb/plugin-sdk/testing`, `/testing/app`, and `/testing/host` for focused tests.
BB's bundled `bb-plugin-authoring` skill documents those harnesses and the live loop.
For another BB build, use that checkout's own QA documentation and `scripts/bb-dev-app` launcher.

## License

MIT
