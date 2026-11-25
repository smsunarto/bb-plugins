# Secrets

Secrets (`scott-secrets`) lets an agent ask the user for a credential without seeing it. `bb secret request` puts a form in the thread. What the user types goes straight into a dotenv file on the thread's host, with mode 0600 and existing assignments preserved. The transcript records only the variable names. `bb secret sudo -- <command>` shows the user the exact root command and asks for the sudo password. That thread's later sudo commands run without a form until the cache window ends. `bb secret forget-sudo` drops the cached password. One setting controls the cache window.

## Sub-features

- `secrets-request-form` renders the **Add secrets** form for `bb secret request`. It shows the purpose, `Secrets will be written directly to <path>`, one masked field per variable with its description, a `Show <NAME>`/`Hide <NAME>` toggle, and **Add secrets** and **Cancel**.
- `secrets-request-write` writes the submitted values to the dotenv file with mode 0600. The CLI prints `{"path","names","added","updated","unchanged"}`, and the thread timeline keeps `Provided <names>` without the values.
- `secrets-request-reconcile` rewrites an existing assignment in place, keeping `export` and any trailing comment, appends new names, and leaves other lines alone.
- `secrets-request-cancel` closes the form on **Cancel**, and the CLI fails with `Secret request cancelled (user).` and no write.
- `secrets-request-validate` covers refusals. The CLI refuses bad names, duplicate names, a `--describe` for an unrequested name, an empty `--purpose`, a call from outside a thread, a file with duplicate assignments, and a file with multiline quoted values. The form refuses a value over 16 KiB and a value that no dotenv quoting can hold.
- `secrets-sudo-form` renders **Run with sudo** for `bb secret sudo`. It shows the purpose, `# <command>`, `Runs as root in <cwd> on <host>.`, a `sudo password` field with `Show sudo password`, the cache note `… for <N> min …`, and **Run as root** and **Deny**.
- `secrets-sudo-deny` exits the CLI with `sudo request denied (user).` (`sudo_request_denied`) when the user chooses **Deny**, and nothing runs.
- `secrets-sudo-run` runs an approved command with the CLI exiting on the command's exit code. Later commands in the same thread run without a form until the window ends. A wrong password gives `sudo_auth_failed`, and `--timeout` stops a long command.
- `secrets-sudo-validate` refuses a missing command after `--`, an empty `--purpose`, and a call from outside a thread.
- `secrets-forget-sudo` prints `{"host","thread","forgotten"}` for the invoking thread.
- `secrets-setting` is **Remember sudo password per thread (minutes)** (`sudoCacheMinutes`, default 15, clamped to 1–1440). Its value appears in the sudo form.
- `secrets-skill` is the bundled `secrets` agent skill. It tells agents to use these commands instead of asking for secrets in chat.

## How to get to it (user POV)

- An agent in a thread runs `bb secret request …` or `bb secret sudo … -- …`. The form appears in that thread's pending-interaction area, and the CLI blocks until the user answers.
- Open **Settings → Plugins → Secrets** (`$URL/settings/plugins/scott-secrets`) for the cache setting.
- An agent or the user runs `bb secret forget-sudo` from the thread.
- Every `bb secret` command needs thread context. The test CLI wrapper `"$TB"` strips every `BB_*` variable, so a call through it reaches only the argument checks and then `missing_thread`. The recipes below use a helper that runs the test CLI as a fixture thread instead of paying for an agent turn.

## Driving it with agent-browser

Preconditions:

- The doctor passes with `--plugin scott-secrets`.
- bb's built-in `secrets` plugin is disabled on the instance, because both claim `bb secret`. `"$TB" plugin list --json | jq -r '.plugins[] | select(.id=="secrets" or .id=="scott-secrets") | "\(.id) \(.enabled)"'` prints `scott-secrets true` and `secrets false`, and `"$TB" secret --help` lists `request`, `sudo`, and `forget-sudo`. If `sudo` is missing, the built-in is answering.
- Use only disposable values such as `verify-alpha-1`. Never type, read, or copy a live secret or the machine's real sudo password. Never read a dotenv file other than this run's fixtures.
- Never submit the sudo form with any value, a dummy included. **Run as root** runs `sudo -v` against the real account, and each wrong password is a failed-login strike that can lock the user out. A verifier only ever chooses **Deny**.
- Secret requests act on the calling thread, which `"$TB"` cannot be. The skill's `scripts/as-thread.sh <thread-id> <cwd> <bb args…>` runs the test CLI as a thread; it reads routing from `"$TB"` and refuses any server that is not a loopback test port.
- Register the fake agent (SKILL.md **Free agent turns**), then create a fixture project and a thread with one fake turn. Record the printed ids:

  ```bash
  FX="$BB_THREAD_STORAGE/verify/$RUN-fixtures"; mkdir -p "$FX"
  git init -q "$FX/verify-secrets" && git -C "$FX/verify-secrets" commit -q --allow-empty -m init
  "$TB" project create --name verify-secrets --root "$FX/verify-secrets" --json | jq -r '.project.id // .id'   # <project-id>
  printf 'ok\n' > "$EV/reply.md"
  "$TB" thread spawn --project <project-id> --title "Secrets fixture" --prompt hello --provider acp-verify-fake \
    --permission-mode full --environment "$FX/verify-secrets" --json | jq -r '.thread.id // .id'   # <thread-id>
  "$TB" thread wait <thread-id>   # Thread <thread-id> reached status idle.
  AS="$PWD/.agents/skills/verify-bb-plugins/scripts/as-thread.sh"; WS="$FX/verify-secrets"   # run from the repository root
  ```

  The thread needs a live host, which only a turn gives it. Register the free local fake agent first (SKILL.md **Free agent turns**; provider `acp-verify-fake`): one fake turn with `--environment` gives the thread `environmentId` `env_…` and a host. Confirm with `"$AS" <thread-id> "$WS" secret forget-sudo --json`, which prints `{"host":"<host>","thread":"<thread-id>","forgotten":false}`.

- **No live host.** Spawn a second thread with `--send-at` a week out (`<scheduled-thread-id>`) and no fake turn. A thread that never ran has no host, with or without `--machine <id>` or `--environment <path>` on the spawn. `"$AS" <scheduled-thread-id> "$WS" secret request VERIFY_ALPHA --purpose dup --write-env .env.dup --json` and `"$AS" <scheduled-thread-id> "$WS" secret forget-sudo --json` each exit 1 with `{"ok":false,"error":{"code":"missing_host","message":"The thread needs a live host."}}` on stdout and the message on stderr. `secret sudo --purpose x -- id -u` exits 1 with `The thread needs a live host.`. Nothing is written.

- **Argument refusals (`secrets-request-validate`, `secrets-sudo-validate`).** These need no thread. Each command exits non-zero and prints the quoted message on stderr:
  - `"$TB" secret request 1BAD --write-env x.env` prints `Variable name must start with a letter or underscore and contain only letters, digits, and underscores.`
  - `"$TB" secret request A A --write-env x.env` prints `Variable names must be unique.`
  - `"$TB" secret request A --describe B "text" --write-env x.env` prints `--describe references unrequested variable B.`
  - `"$TB" secret request A --purpose "" --write-env x.env` prints `--purpose requires a non-empty description. (Write --purpose 'why these credentials are needed'.)`
  - `"$TB" secret request A --write-env x.env` prints `bb secret request must run from a bb thread.`
  - `"$TB" secret sudo --purpose x` prints `bb secret sudo needs a command after --. (Write bb secret sudo --purpose 'why' -- pacman -Syu)`
  - `"$TB" secret sudo -- id -u` prints `bb secret sudo must run from a bb thread.`
  - `"$TB" secret forget-sudo` prints `bb secret forget-sudo must run from a bb thread.`

  Each exits 1. Add `--json` before `--` to get the failure envelope on stdout as well, pretty-printed: `"$TB" secret request 1BAD --write-env x.env --json` prints `{"ok":false,"error":{"code":"invalid_variable_name","message":"…"}}`, and `"$TB" secret forget-sudo --json` prints code `missing_thread`. The other codes (`duplicate_variable_name`, `unrequested_describe`, `invalid_purpose`, `missing_command`) come from the source and were not each read back. For `secret sudo`, a `--json` after `--` becomes part of the command.

- **Request form (`secrets-request-form`).** Start the request in the background:

  ```bash
  "$AS" <thread-id> "$WS" secret request VERIFY_ALPHA VERIFY_BETA \
    --purpose "Verify the secrets form" \
    --describe VERIFY_ALPHA "Disposable alpha value" \
    --describe VERIFY_BETA "Disposable beta value" \
    --write-env .env.verify > "$EV/req1.out" 2> "$EV/req1.err" & echo $! > "$EV/req1.pid"
  ```

  Then run `agent-browser --session "$RUN" open "$URL/threads/<thread-id>"` and `agent-browser --session "$RUN" wait --text "Secrets will be written directly to" --timeout 20000`. The form is a region `Add secrets` whose header is a collapse button also named `Add secrets` (`expanded=true`). It shows `Verify the secrets form`, `Secrets will be written directly to <WS>/.env.verify`, each field as a required textbox named by the variable with its description below, buttons `Show VERIFY_ALPHA`, `Show VERIFY_BETA`, `Cancel`, and the submit `Add secrets`, and the host name. The timeline row reads `Requesting VERIFY_ALPHA, VERIFY_BETA`.

- **Show and Hide.** Run `agent-browser --session "$RUN" find role button click --name "Show VERIFY_ALPHA"`. The button becomes `Hide VERIFY_ALPHA` (no `aria-pressed`), and the field's type changes from `password` to `text`. Check the type with `agent-browser --session "$RUN" eval 'document.querySelector("input[name=VERIFY_ALPHA]").type'`, which returns `"text"`. Choose it again to mask the field.
- **Submit and write (`secrets-request-write`).** Fill both fields in this order, because new names are appended in the order they were typed: `agent-browser --session "$RUN" find label "VERIFY_ALPHA" fill "verify-alpha-1"`, then `agent-browser --session "$RUN" find label "VERIFY_BETA" fill "verify-beta-1"`, then click the submit `Add secrets` by its snapshot ref: `find role button … --name "Add secrets"` (even with `--exact`) hits the region's collapse button first and only folds the form. Wait for the CLI with a bounded `kill -0 <pid>` loop; `tail --pid` returned at once here. `"$EV/req1.out"` holds `{"path":"<WS>/.env.verify","names":["VERIFY_ALPHA","VERIFY_BETA"],"added":2,"updated":0,"unchanged":0}`.
  - **Second view:** `stat -c %a "$WS/.env.verify"` prints `600` (macOS: `stat -f %Lp`), and `diff <(printf "VERIFY_ALPHA='verify-alpha-1'\nVERIFY_BETA='verify-beta-1'\n") "$WS/.env.verify"` is silent. That is a disposable fixture file, never a real one.
  - **No leak:** the timeline row now reads `Provided VERIFY_ALPHA, VERIFY_BETA`. `agent-browser --session "$RUN" eval 'document.body.innerText.includes("verify-alpha-1")'` returns `false` after a reload, and `"$TB" thread show <thread-id> --json | grep -c verify-alpha-1` and `"$TB" thread log <thread-id> --json | grep -c verify-alpha-1` print `0`.
- **Reconcile (`secrets-request-reconcile`).** Write `printf 'export VERIFY_ALPHA="old" # keep me\nOTHER_KEEP=1\n' > "$WS/.env.reconcile"`. Request `VERIFY_ALPHA VERIFY_GAMMA --purpose Reconcile --write-env .env.reconcile` as above. Fill `VERIFY_ALPHA` with `verify-alpha-2` first, then `VERIFY_GAMMA` with `verify-gamma-1`, and submit. The output has `"added":1,"updated":1,"unchanged":0`, and `diff <(printf "export VERIFY_ALPHA='verify-alpha-2' # keep me\nOTHER_KEEP=1\nVERIFY_GAMMA='verify-gamma-1'\n") "$WS/.env.reconcile"` is silent.
- **Refused files (`secrets-request-validate`).** Write `printf 'VERIFY_ALPHA=1\nVERIFY_ALPHA=2\n' > "$WS/.env.dup"`. Requesting `VERIFY_ALPHA --write-env .env.dup` through `"$AS"` exits 1 before any form appears with `Dotenv file contains duplicate assignments for VERIFY_ALPHA.`. A file containing `VERIFY_ALPHA="line` exits 1 with `Dotenv files with multiline quoted values cannot be reconciled safely.`.
- **Oversized value.** Start a one-variable request. Fill the field with 16,385 characters: `agent-browser --session "$RUN" find label "VERIFY_ALPHA" fill "$(head -c 16385 /dev/zero | tr '\0' a)"`. Click the submit by ref. The form stays, the CLI keeps waiting, and the form shows `Every secret must be a non-empty single-line value no larger than 16 KiB.`. Then fill it with `a'b"c #d` and choose **Add secrets** again. The form shows `One value cannot be represented safely in a dotenv assignment.`. Then cancel it.
- **Cancel (`secrets-request-cancel`).** On an open request form, click its `Cancel` by snapshot ref (the page has other `Cancel` buttons). The CLI exits with `Secret request cancelled (user).` on stderr, and the target file does not exist (`test ! -e "$WS/<file>"`).
- **Sudo form (`secrets-sudo-form`).** Read the mirrored window with `"$TB" plugin config scott-secrets --json | jq .values.sudoCacheMinutes`, then start `"$AS" <thread-id> "$WS" secret sudo --purpose "Verify the sudo form" -- id -u > "$EV/sudo1.out" 2> "$EV/sudo1.err" & echo $! > "$EV/sudo1.pid"`. Run `agent-browser --session "$RUN" wait --text "Runs as root in" --timeout 20000`. The form is a region `Run with sudo` (collapse button of the same name). It shows `Verify the sudo form`, `# id -u`, `Runs as root in <WS> on <host>.`, the required textbox `sudo password` with button `Show sudo password`, `Kept only in memory on <host>, for this thread only, for <N> min. Until then, this thread runs sudo commands without asking again.`, and buttons `Deny` and `Run as root`. <!-- unverified: a `Requesting sudo: id -u` timeline row; the rows collapse into the turn's `Worked` group -->
- **Deny (`secrets-sudo-deny`).** Run `agent-browser --session "$RUN" find role button click --name "Deny"` and wait on the pid as above. The CLI exits, and `"$EV/sudo1.err"` holds `sudo request denied (user).`. Nothing reaches sudo before the form, so this path adds no failed-login strike.
- **Forget (`secrets-forget-sudo`).** Run `"$AS" <thread-id> "$WS" secret forget-sudo`, which prints `{"host":"<host>","thread":"<thread-id>","forgotten":false}`.
- **Setting (`secrets-setting`).** Record `"$TB" plugin config scott-secrets --json | jq -c .values` first (mirrored live value: `{"sudoCacheMinutes":15}`, the default). Open `$URL/settings/plugins/scott-secrets` and wait for `Remember sudo password per thread (minutes)`; the field is a spinbutton of that name. Set it to 5 with `"$TB" plugin config scott-secrets set sudoCacheMinutes 5`, which prints `sudoCacheMinutes = 5  (number)` and the description; a reload shows `5` in the spinbutton. Filling the spinbutton (`find role spinbutton fill --name "Remember sudo password per thread (minutes)" "7"`, then `press Tab`) saves `7`. The page also accepts and stores `0` with no validation message; the 1–1440 clamp applies only when a sudo form computes its window: with `5` a new sudo form reads `for 5 min`, with `0` it reads `for 1 min`. Deny each. Restore with `"$TB" plugin config scott-secrets unset sudoCacheMinutes`, which prints `sudoCacheMinutes = 15`.
- **Skill (`secrets-skill`).** `"$TB" skill list --json | jq -c '.skills[] | select(.name=="secrets") | {name, pluginId}'` prints `{"name":"secrets","pluginId":"scott-secrets"}`; with the built-in disabled, only the fork's skill is listed.
- **Unreachable without the user (`secrets-sudo-run`).** <!-- unverified: needs the real sudo password --> The successful run, the cached run without a form, `sudo_auth_failed`, `--timeout`, output truncation, and cache expiry all need the machine's real sudo password. A verifier must not type it, and a wrong password adds a failed-login strike to the user's account. Hand this path to the user: they type the password in a headed browser, and the verifier then checks `id -u` printing `0`, a second `secret sudo -- true` with no form, and `forget-sudo` printing `"forgotten":true`.
- **Proof.** Screenshot each form state with `agent-browser --session "$RUN" screenshot "$EV/secrets-<state>.png"`, and keep the `.out` and `.err` files.
- **Cleanup.** Kill any request still waiting with `kill "$(cat "$EV/<name>.pid")"` (the form then cancels with `request-aborted`). Restore `sudoCacheMinutes`, run `"$AS" <thread-id> "$WS" secret forget-sudo`, then `"$TB" project delete <project-id> --yes`, and remove `$FX`. The fixture dotenv files go with `$FX`.

## Gotchas

- The `"$TB"` wrapper unsets every `BB_*` variable, including `BB_THREAD_ID`, so through it every real command stops at `must run from a bb thread`. Use the `as-thread.sh` helper. Inside it, the variables are cleared before the wrapper's own exports, so the live thread's `BB_CLI` or `BB_SERVER_URL` cannot leak in. It still bypasses the wrapper, as Preconditions says.
- The CLI blocks until the form is answered. Always start it in the background and bound the wait with `timeout`.
- Masked fields are `type=password` but still expose role `textbox` with the variable's name; `find label "<NAME>" fill` works on them.
- `Show`/`Hide` buttons are 28 px tall at every width, below the 44 px touch target AGENTS.md requires on compact layouts. Report this as a product gap if a phone check is in scope.
- A form left open when the plugin reloads or bb restarts cancels with `plugin-disposed` or `server-restarted`. Start a fresh request after any reload.
- The relative `--write-env` path resolves from the helper's working directory, `$WS`. The form shows the resolved absolute path.
- Never verify with `cat` on a non-fixture env file. These recipes read back only the disposable files they created.
- A scheduled `--send-at` fixture thread has no live host, so every `bb secret` thread command fails with `missing_host` on it. `--machine` and `--environment` on `thread spawn` do not bind one before the first turn; one fake-agent turn does.
- The form's region header and its submit share the name `Add secrets` (and `Run with sudo` for the sudo form); click the submit by ref.
- Remove your fake-agent entry from `provider-acp` `customAgents` at the end (SKILL.md **Free agent turns**).
- `plugin config … set` and the settings spinbutton accept `0` and other out-of-range values without complaint; only the sudo form clamps them.
