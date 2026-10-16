MiniMax H3 Max (`minimax/h3-max/reference-to-video` on fal, the Hailuo successor) is a video model with native audio. It is best at prompt-faithful game motion and start-to-end keyframe moves. Prompt expansion is disabled, so write the final structured prompt yourself.

## Prompt structure

1. When frames are attached, an alignment line, then a blank line:
   - Start image only: `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`
   - Start and end: `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the D.DD-second mark of the target video.` D.DD is the request's duration.
2. `integrated_multimodal_description: [Shot 1] ...`: style and composition, then action, camera, and dialogue in order.
3. `overall_soundscape: ...`: ambience and action sounds, one to four sentences.
4. `non_diegetic_music: ...`: instruments and tempo, or `N/A`.

Separate the fields with blank lines.

## Rules

- Write camera moves as sentences with type, amplitude, and speed: "The camera pushes in with small amplitude at slow speed." Types: Pan, Truck, Tilt, Pedestal, Push In/Pull Out, Zoom, Arc Shot, Tracking Shot, Static Shot. Never write bracket commands like `[Pan left]`.
- Prefer one shot. Add `[Shot 2] At 00:03.000, the camera cuts to ...` only when asked, within the duration.
- With frames, describe only the motion away from the start image and toward the end image.
- Write dialogue with speaker IDs: `The paladin (S1) says: <d>[English] Stand fast!</d>`
- Quote on-screen text exactly. Put negatives in the description.

## The app controls these settings

Except for the duration in the alignment line, do not mention:

- duration
- resolution
- aspect ratio
- prompt expansion
- frame attachment

## Example

```text
integrated_multimodal_description: [Shot 1] 3D CG, stylized game cinematic, a crystal golem in a moonlit cavern smashes its fist into the floor as the camera arcs right at slow speed. No on-screen text.

overall_soundscape: Grinding stone and a heavy impact boom over low cave wind.

non_diegetic_music: N/A
```
