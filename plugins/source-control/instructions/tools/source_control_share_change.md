Show the human a Source Control card for this thread's Change: its branch or pull request, where it is on the way to merged, and its open review items, with a link to review it. Use it when committed work on this thread's branch is ready for the human to look at.

BEFORE CALLING
Commit the work first. The card reads the Change from this thread's checkout and branch; a thread with no checkout or no branch has no Change to show, and the call fails saying so.

RETURNS AND NEXT STEP
Returns a `::source-control` directive naming the Change and its current head. Put it verbatim on its own line in your response, outside code fences. The card stays live: later commits, checks and review items show on it without calling again. It publishes nothing, sends nothing and changes no review state.
