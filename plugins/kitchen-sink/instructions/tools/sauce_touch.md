Touch the device screen with one finger: a tap, a press-and-hold, or a drag. Coordinates are fractions (0 to 1) of the last `sauce_screenshot`, measured from its top-left corner.

- Tap: `x`, `y`.
- Press and hold (long press, holding a button): add `hold_ms`.
- Drag or swipe: add `to_x`, `to_y`, and optionally `duration_ms`.
- Joystick: drag from the stick's centre toward the direction and keep `hold_ms` for as long as the character should move; release ends the movement.

Set `screenshot_after_ms` to wait and capture the result in the same call. Only one finger is available, so multitouch (moving while tapping another control) cannot be tested here. Requires a screenshot taken in the current session; after `sauce_device` rotate, take a new one first.
