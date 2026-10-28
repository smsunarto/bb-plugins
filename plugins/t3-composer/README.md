# T3 Composer

A fork of BB’s composer with T3 Code’s rounded surface, editor spacing, flat footer controls, right-aligned attachments, and rounded-square send button. Colors and the selected font follow the active BB theme. Save draft is a direct icon action beside the attachment and microphone buttons, including in collapsed composers.

Install this directory with `bb plugin install .`, then choose **T3 Composer** under **Settings → Appearance → Composer** if Automatic has not selected it. Requires BB 0.47.1 and SDK 0.6.79. To switch back, choose the built-in **Composer** there.

Drafts, uploads, voice input, history, model selection, and sending use BB’s public composer API. Save draft holds the message in BB’s queue until you send it manually. This plugin replaces their presentation in thread, new-thread, queued-message, and sent-message composers. It retains BB’s prompt-action menu and shows other plugins’ composer actions, including BB’s overflow menu, to the right of the model selector; compact composers omit them as BB’s composer does. Alternate send actions remain available with a hardware keyboard. The removed send-options menu and long-press sheet are not available on touch-only devices. Save draft follows the built-in Drafts plugin’s scope and availability, so Drafts must be enabled. BB excludes queued-message and sent-message editors.

Upstream code and licenses are recorded in THIRD_PARTY_NOTICES.md.
