Touch the device screen with one finger: a tap, a press-and-hold, or a drag. Coordinates are fractions (0 to 1) of the last `sauce_screenshot`, measured from its top-left corner.

- Tap: `x`, `y`.
- Press and hold (long press, holding a button): add `hold_ms`.
- Drag or swipe: add `to_x`, `to_y`, and optionally `duration_ms`.
- Joystick: drag from the stick's centre toward the direction and keep `hold_ms` for as long as the character should move; release ends the movement.

Set `screenshot_after_ms` to wait and capture the result in the same call. If only that capture fails, the result still reports the gesture with a `screenshot_error`: the touch landed, so take a `sauce_screenshot` instead of repeating it. Only one finger is available, so multitouch (moving while tapping another control) cannot be tested here. Requires a screenshot taken in the current session. Take a new one after `sauce_device` rotate and after the app launches or switches orientation: the screenshot sets the rotation every touch is mapped through. Fails with `no_frame` before the session's first screenshot and after `sauce_device` rotate until a new screenshot is taken.
