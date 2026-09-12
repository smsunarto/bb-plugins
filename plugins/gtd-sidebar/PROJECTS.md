# Projects

Projects give a native BB conversation a persistent coordinator, delegated agent threads, shared
context, and subscriptions. GTD Sidebar must be loaded for project tools and subscription work to
run.

## Create a project

1. Open **Projects** in the left sidebar and select **New project**.
2. Enter a name. The icon and description are optional.
3. Under **Workspace**, select one or more BB repository projects. Select **Start from scratch** to
   use the personal project instead.
4. Choose the coordinator's **Environment** and **Model**, then select **Create Project**.

BB opens the project's coordinator as a normal conversation. The selected workspaces become the
repositories available for delegated agents. The first selected workspace is the coordinator's
primary workspace.

## Delegate work

Ask the coordinator to split an outcome into bounded tasks. It creates child threads, tracks their
status, and can steer them as the work changes.

To start a task yourself, open **Agents**, select **New agent**, and provide the **Task**,
**Workspace**, **Environment**, and **Model**. Select **Start agent**. An agent can run only in a
workspace bound to the project. Open an agent row to inspect its conversation, or use **Reference
in chat** to add it to the coordinator's composer.

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
