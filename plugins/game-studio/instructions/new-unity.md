Create a Unity project for this game using `game-dev` and the
Unity new-project workflow. Requested Editor: {{unityVersion}}.
Requested template: {{unityTemplate}}.

The submitted `unitySetup` records the user's chosen
Editor `version` and `template`: `3d-urp` means 3D URP, `2d-urp` means 2D URP,
and `empty` means an empty project. Use the requested version exactly when it is
provided. A null version means inspect installed Editors/Unity Hub and choose a
compatible version. If the chosen version or template is unavailable, report the
blocker and ask before substituting another. If no setup was provided, determine
a compatible version and template from the user's brief. The workspace may already
contain `canvas/` design files; preserve those and do not overwrite unrelated
files. Use Unity's real project creation tooling; do not fabricate ProjectSettings
or pretend a folder is a working Unity project. Ask for Unity account/license
authentication if needed. Discover and claim the exact main Editor before
controlling it or writing shared Assets/Packages. Establish a functional scene
and appropriate compilation/smoke checks, then report the actual Editor version,
project path, and verification. Preserve the design canvas throughout setup.
