# Laser Graffiti

Draw on a projected surface with a laser pointer. A camera watches the projection area, finds the laser dot,
maps it into projector coordinates via a calibrated homography, and the projector renders the stroke.

## Run

```sh
npm start            # http://localhost:8765
```

1. **Control window** (`/`): pick the camera that sees the projection surface → *Start camera*.
2. *Open projector window* → move it onto the projector → press **F** for fullscreen.
3. *Auto-calibrate*: white markers are flashed into the projector's corners and located in the camera
   image (on/off flashing cancels ambient changes and moving people). Yellow corners on the camera
   preview can be dragged to fine-tune. Calibration is saved in `localStorage`.
4. Point the laser at the surface and draw. Keyboard: `c` clear, `z` undo.

Keep the control window visible (it can be small) — Chrome throttles occluded windows.

## Detection

Frames are downscaled to 480px, pixels with a dominant green (or red) channel are collected, and a
weighted centroid is taken around the brightest candidate. Tune *Min channel* / *Dominance* using
*show detection mask*. Avoid drawing in the same colour as the laser or the camera sees the projected
stroke as a laser (feedback loop).

## Files

- `server.mjs` – static server (no dependencies)
- `public/app.js` – control UI, camera loop, detection, calibration
- `public/projector.js` – fullscreen drawing surface, receives strokes via `BroadcastChannel`
- `public/shared.js` – homography math, stroke rendering
