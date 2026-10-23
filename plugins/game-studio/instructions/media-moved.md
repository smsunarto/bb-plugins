# Game Studio media moved

Game Studio keeps this checkout's generated and uploaded media, and the input
snapshots its generations read, outside the checkout, in:

{{mediaDir}}

`canvas/staging/<path>` on the canvas is `staging/<path>` there, and
`canvas/inputs/<path>` is `inputs/<path>`. Write new staged files there, and keep
naming them by their `canvas/` paths in boards and `canvas/assets.json`.

If that folder is gone, Game Studio writes new media here again and stops freeing
unused files, so the catalog keeps its entries. Restore the folder, or delete
`.moved` here to move this folder's media again.
