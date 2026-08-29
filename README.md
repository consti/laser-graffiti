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
4. *Calibrate laser*: wave the laser inside the projection for 4 s. Channel/dominance thresholds and the dot
   size are learned from what the camera actually sees (a strong laser with a blown-out white core is detected too).
5. Point the laser at the surface and draw. Keyboard: `c` clear, `z` undo, `m` toggle menu.

## Laser menu

A dashed ☰ circle sits in the top-right corner of the projection. Hold the laser in it for half a second to open
the menu; hover an item for ~0.65 s to activate it. It offers colours, brushes, effect toggles, mirror mode,
size, undo, clear, and close. The menu closes itself after 8 s without a laser.

## Brushes & modes

- Brushes: round, marker (translucent, flat), calligraphy (width follows speed), neon (glow), spray, rainbow.
- **Wet ink** – strokes spawn drips that run down the surface.
- **Spin 3D** – the drawing becomes an extruded plate that rotates around its vertical axis.
- **Fade** – strokes dissolve after N seconds (slider in the control window, 6 s from the menu).
- **Mirror** – kaleidoscope ×2/×4/×6/×8 around the centre.
- **Sparkle** – a particle trail follows the laser while drawing.

## Reflections & robustness

Candidate pixels are clustered into up to four blobs. The tracker follows the blob nearest to the previous
position and otherwise takes the strongest one (reflections are dimmer than the direct dot). A new stroke only
starts once the dot is seen in two consecutive frames, and detection is limited to the calibrated projection
quad. If the shiny floor still shows up, tick *show detection mask* and raise *Dominance*/*Min channel*, or
lower *Tracking radius*.

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
