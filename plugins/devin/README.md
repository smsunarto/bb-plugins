# Devin

**Run [Devin](https://devin.ai/cli) in a bb thread, locally or on a Devin Cloud VM.**

The plugin registers Devin as a bb provider. It runs `devin acp` through the
plugin SDK's generic ACP bridge, so models, reasoning, tool calls, and
permission prompts come from Devin itself.

## Install

Install the Devin CLI and sign in once:

```sh
curl -fsSL https://cli.devin.ai/install.sh | bash
devin auth login
```

Then install the plugin:

```sh
bb marketplace add git:github.com/smsunarto/bb-plugins
bb plugin install devin
```

## Usage

Pick **Devin** in bb's provider list and start a thread.

### Local and Cloud

Devin runs in the bb environment's working directory by default. To run a
thread on a Devin Cloud VM, press **Cloud** in the new-thread composer, then
send the first prompt. The toggle shows only while Devin is selected, and an
armed toggle expires after 10 minutes.

Local or Cloud is fixed for the life of the thread. A Cloud thread shows a bar
above the composer with a link to the session in the Devin web app and a
copyable `devin --cloud -r <session>` command to attach from a terminal.

A Cloud thread's first prompt tells Devin which repository the bb project has
open, so Devin clones it on its VM. Projects without a git remote send nothing.

### Permissions

- **Full** approves every Devin tool request.
- **Accept Edits** runs Devin in its Code mode, which approves workspace edits
  and asks bb for everything else.

## Known limits

- `devin acp --cloud` can answer the prompt before it streams Devin's final
  message. The plugin holds the end of a Cloud turn for up to 1.5 seconds so
  that message still lands in the turn, which is why a Cloud turn shows as
  running a moment after Devin's last reply.
- Cloud threads use Devin Cloud's default model. The bb model picker applies
  to local threads.

## Develop

```sh
bun run typecheck
bun run test
bun run build
```
