# Laser Graffiti

Draw on a projected surface with a laser pointer. A camera watches the projection area, finds the laser dot,
maps it into projector coordinates via a calibrated homography, and the projector renders the stroke.

Live at **https://laser.consti.de** (landing page with a mouse-driven demo; the app is at `/app.html`).

## Run

```sh
npm start            # http://localhost:8765  (landing page + demo; control app at /app.html)
```

1. **Control window** (`/app.html`): pick the camera that sees the projection surface → *Start camera*.
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

## Tic-tac-toe, border, snapshots

- **Tic-tac-toe** (toggle in the control window or the laser menu): a 3×3 board is projected; draw an X inside a
  cell and the computer (minimax) answers with an O. A second stroke in the same cell is kept so you can finish
  your X. Illegal strokes are discarded. The board resets 4 s after the game ends.
- **Border**: a frame in a colour of your choice around the drawable area — handy to see the projection edge.
- **Snapshots** (`s`, button, or menu): stores the camera photo plus the strokes in `localStorage`. Each snapshot
  can be downloaded as the photo, the drawing (1920×1080 PNG), or the photo with the drawing warped onto it via the
  inverse calibration homography; *restore* puts the strokes back on the wall.

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
- `public/index.html`, `public/demo.js` – landing page with the mouse demo
- `public/app.html`, `public/app.js` – control UI, camera loop, detection, calibration, laser menu, snapshots
- `public/projector.html`, `public/projector.js` – fullscreen drawing surface, receives messages via `BroadcastChannel`
- `public/scene.js` – the renderer (brushes, effects, menu, board) shared by projector, demo and snapshots
- `public/game.js` – tic-tac-toe engine
- `public/shared.js` – homography math, settings, menu layout, brush rendering

MIT licensed.
