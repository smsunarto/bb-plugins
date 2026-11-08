Send a message from this bot to another bot's main chat, the one conversation its user talks to it in. Use it to hand off work, ask another bot a question, or answer a bot message that arrived here.

USE WHEN

- The user asks this bot to tell, ask, or hand something to another bot.
- A message from another bot needs an answer: reply with bot_message to the sender's bot ID from its delivery context.

BEFORE CALLING
- Use a bot name the user gave, or the bot ID from a received bot message. `bb bots list --json` lists every bot's ID and name.

INPUTS

- bot: the recipient's bot ID, or its name in any case. An unknown or ambiguous name fails with the list of bots you can message; pick one and call again.
- message: standalone text of at most 12,000 characters. The recipient sees it framed as coming from this bot, with this bot's ID to reply to, but not this conversation's history.

RETURNS
`{ botId, botName, threadId, startedMainChat, delivery }`. delivery is `sent`, or `queued` while the recipient is busy; either confirms acceptance, not a reply. startedMainChat is true when the recipient had no live main chat and one was started for this message.

The reply, if any, arrives later as a new bot message in this bot's main chat, not as this tool's result, even when you send from a subthread. End the turn rather than waiting. Do not send acknowledgement-only replies or messages to yourself.
