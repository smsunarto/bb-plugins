End this thread's Sauce live session and release the device for other threads. Call it as soon as device testing is done, and before reporting results; the account has one live slot.

Called from a thread that does not hold the device, it ends the session only when the holder has been idle for 15 minutes or more; otherwise it fails with `held_by_other_thread`. It never ends a session that no bb thread leased (a person's, or a script's).
