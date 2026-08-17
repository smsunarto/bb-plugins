---
"@smsunarto/bb-plugin-t3sidebar": minor
---

Compact the inbox. The thread card drops to two lines — title and status, then
project, branch, activity, PR and agent — for 52px instead of ~75px. Slim rows,
shelf headers and the project scope picker each lose a few pixels with them.
The meta line sits one full step below the title in both size and tint, and
cards keep a real gap rather than a hairline.

Add a **Show the agent icon on each card** setting, on by default. Turning it off
drops the trailing agent glyph and gives the branch that space back.
