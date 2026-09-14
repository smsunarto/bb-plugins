# Projects

Projects coordination and Project subscriptions are separate opt-ins in
**Settings → Plugins → GTD Sidebar**, both off by default. See the
[feature catalog and migration behavior](README.md#configuration) before enabling
automation. Disabling preserves Projects data and native threads.

Projects give a native BB conversation a persistent coordinator, delegated agent threads, shared
context, and subscriptions. GTD Sidebar must be loaded for project tools and subscription work to
run. Shared-directory Projects require BB 0.43.1 or newer.

## Create a project

1. Open **Projects** in the left sidebar and select **New project**.
2. Enter a name. The icon and description are optional.
3. Under **Repositories**, select one or more BB repository projects. Select **Start from scratch**
   to use the personal project instead.
4. For a project with multiple repositories, keep **Shared directory** to let the coordinator and
   every agent reuse one existing directory that contains all selected repository checkouts. Review
   the machine, shared directory, and checkout paths. You can edit the directory and validate it
   again before creating the project.
5. Choose the coordinator's **Model**, then select **Create Project**.

BB opens the project's coordinator as a normal conversation. In shared-directory mode, BB creates
one environment at the confirmed common directory. The coordinator and every delegated agent reuse
that environment. Agents can access everything under the shared directory, including files outside
the selected repositories. The selected repositories define the project's named work scope, and the
first selected repository is the native BB project used for the coordinator and agents.

The shared directory must already exist on one machine and contain the independent selected
checkouts. GTD Sidebar does not create a subtree, linked worktrees, or branches. It rejects a root or
home directory, repositories on different machines, duplicate canonical checkout roots, and a
directory that does not contain every selected checkout. Legitimate nested repositories are
allowed. If no valid common directory exists, the form reports the reason and does not silently
choose another directory.

The shared root and repository bindings are fixed after creation. If a saved checkout moves, restore
it at the saved path or create a new Project for the new layout.

**Separate environments** preserves the original project behavior. The coordinator uses the first
selected repository's chosen or default environment, and each agent can use a selected repository's
own environment. Existing projects keep this behavior unless they were created in shared-directory
mode. A new multi-repository project defaults to **Shared directory**. Scratch and single-repository
projects default to **Separate environments**.

## Delegate work

Ask the coordinator to split an outcome into bounded tasks. It creates child threads, tracks their
status, and can steer them as the work changes.

To start a task yourself, open **Agents**, select **New agent**, and provide the **Task**,
**Repository focus**, and **Model**. Select **Start agent**. In a shared-directory project, the
repository is a task focus, not a sandbox boundary. The agent reuses the project's shared directory
and can access everything under it. In a separate-environments project, also choose the agent's
**Environment**. An agent can select only a repository bound to the project. Open an agent row to
inspect its conversation, or use **Reference in chat** to add it to the coordinator's composer.

Run GitButler commands from the checkout they apply to. For example, use `but status` in each
selected repository rather than treating the shared parent directory as one Git repository. BB's
thread has one native project and environment; BB does not provide a combined multi-repository Git
view. Use the terminal or each checkout's GitButler view to inspect and manage its changes.

## Share context

Open the project panel and select **Context**. Create documents such as `notes/plan.md`, then read or
edit them from the same panel. The coordinator and every project agent use this shared context.
Concurrent edits are revision-checked, so a stale save reports a conflict instead of overwriting a
newer version.

## Configure Listening

Open **Listening** above the coordinator composer, or open the project panel and select
**Subscriptions**. Select **New subscription**, then choose a kind:

- **Schedule** sends the coordinator a prompt once or on a five-field cron schedule.
- **GitHub CI** polls workflow runs for a repository and optional branch.
- **GitHub PR** polls activity for one pull request.
- **Slack channel** polls messages from one channel.

Each subscription can be enabled or disabled, edited, deleted, or started with **Run now**. Schedule
and source events are delivered to the coordinator conversation.

GitHub subscriptions run `gh` in the selected environment. Authenticate there first and confirm it
with `gh auth status`. GitHub activity is polled, so delivery is not immediate.

Slack is optional. Set the **Slack bot token** secret in GTD Sidebar's plugin settings and add that
bot to the channel. The integration polls only channel history; it does not poll thread replies or
send Slack messages. The current verification environment did not authenticate against a live Slack
workspace, so Slack behavior has deterministic fixture coverage but no live-account proof.

## Archive and restore

Open the project panel, select **Overview**, then select **Archive project…**. Archiving pauses the
project's subscriptions and archives the coordinator and agent threads. The coordinator conversation
is kept.

To resume the project, open **Projects**, find it under **Archived**, and select **Restore**. Restore
unarchives the conversation tree and resumes enabled subscriptions. Subscription work runs only while
GTD Sidebar is loaded.
