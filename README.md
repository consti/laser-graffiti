# Laser Graffiti

Draw on a projected surface with a laser pointer. A camera watches the projection area, finds the laser dot,
maps it into projector coordinates via a calibrated homography, and the projector renders the stroke.

**Live at https://laser.consti.de** — landing page with a mouse-driven demo; the app itself is at
[laser.consti.de/app.html](https://laser.consti.de/app.html).

▶ [Watch how it works (43 s)](https://laser.consti.de/media/howitworks.mp4) · inspired by
[this video](https://www.youtube.com/watch?v=DKbtTPYZEig) — see the backstory below.

## Backstory

The inspiration came from mzeltner (Michael Zeltner) and oneup (Florian Hufsky) of
[Graffiti Research Lab Vienna](https://graffitiresearchlab.at/), who around 2007 built their own laser
marker and tagged buildings across Vienna with it. They in turn were inspired by the original
[Graffiti Research Lab](https://graffitiresearchlab.com/) in New York and its
[L.A.S.E.R. Tag](https://graffitiresearchlab.com/blog/projects/laser-tag/#video) project — the same idea:
a camera, a projector, and a laser pointer as the pen, writ large on the side of a building. There's a
lovely video of [Bre Pettis talking with Michi about Laser Tag in Vienna](https://youtu.be/isfrCIhQ5HE).

This project is a from-scratch reimplementation of that idea for the browser — no Processing, no install,
just a laptop, a webcam and a projector.

## Run

```sh
npm start            # http://localhost:8765  (landing page + demo; control app at /app.html)
```

1. **Control window** (`/app.html`): pick the camera that sees the projection surface → *Start camera*.
2. *Open projector window* → move it onto the projector → press **F** for fullscreen.
3. *Auto-calibrate*: white markers are flashed into the projector's corners and located in the camera
   image (on/off flashing cancels ambient changes and moving people). Yellow corners on the camera
   preview can be dragged to fine-tune. Calibration is saved in `localStorage`.
4. *Calibrate laser*: a 3 s countdown is projected so you can aim, then wave the laser inside the projection for 4 s. Channel/dominance thresholds and the dot
   size are learned from what the camera actually sees (a strong laser with a blown-out white core is detected too).
5. Point the laser at the surface and draw. Keyboard: `c` clear, `z` undo, `m` toggle menu.

The control window hides the tuning knobs (detection thresholds, border, menu corner, log) behind *show advanced options*.

## Laser menu

A dashed ☰ circle sits in a corner of the projection (top-right by default; pick another corner in the control window or with
*move menu* inside the menu). Hold the laser in it for half a second to open
the menu; hover an item for ~0.65 s to activate it. It offers colours, brushes, effect toggles (incl. flame and burn), mirror mode,
size, effect intensity (`fx −`/`fx +`), undo, snapshot, clear, and close. The menu closes itself after 8 s without a laser.

## Brushes & modes

- Brushes: round, marker (translucent, flat), calligraphy (width follows speed), neon (glow), spray, rainbow.
- **Wet ink** – strokes spawn drips that run down the surface.
- **Spin 3D** – the drawing becomes an extruded plate that rotates around its vertical axis.
- **Fade** – strokes dissolve after N seconds (slider in the control window, 6 s from the menu).
- **Mirror** – kaleidoscope ×2/×4/×6/×8 around the centre.
- **Sparkle** – a particle trail follows the laser while drawing.
- **Flame** – fire licks up from the freshly drawn part of the stroke (it keeps burning for ~2 s after the laser has passed).
- **Burn** – permanent scorch marks on the wall, see below.
- **Effect intensity** (slider in the control window, `fx −`/`fx +` in the laser menu, ×0.25…×3): one knob that scales every
  effect — how often and how far wet ink drips, how many sparks, how big and how many flames, how hot and how long a burn glows.

## Burn into the surface

Burn mode leaves *marks* on the wall instead of painting light onto it. A projector can only add light, so the trick is
restraint: around each stroke only a dim, brownish, soft‑edged scorch halo is projected (heat discolouration outside,
darker soot towards the middle), while the core itself gets no light at all and stays the natural, unlit wall — which reads
as the darkest, charred part. The marks are permanent; only the tip glows white → orange → ember for a moment while you
draw, with a few sparks and wisps of smoke. The *marks* slider sets how visible the scorch is; intensity scales the halo size.

**Scan surface** makes the marks belong to *this* wall: the projector is blanked, the camera photographs the wall, and the
photo is warped through the inverse calibration homography into projector space. The halo is then textured with the wall's
own bricks, plaster and stains (browned), so the scorch looks like it is in the material rather than floating on it. The scan
is kept in `localStorage`; without a scan a plain brown halo is used. Needs a projector calibration first.

## Tic-tac-toe, border, snapshots

- **Tic-tac-toe** (toggle in the control window or the laser menu): a 3×3 board is projected; draw an X inside a
  cell and the computer (minimax) answers with an O. A second stroke in the same cell is kept so you can finish
  your X. Illegal strokes are discarded. The board resets 4 s after the game ends.
- **Border**: a frame in a colour of your choice around the drawable area — handy to see the projection edge.
- **Snapshots** (`s`, button, or menu): stores the camera photo plus the strokes in `localStorage`. Each snapshot
  can be downloaded as the photo, the drawing (1920×1080 PNG), or the photo with the drawing warped onto it via the
  inverse calibration homography; *restore* puts the strokes back on the wall.

## Smooth lines

Two sliders fight laser jitter. *Position smoothing* (Detection) low-pass filters the live position — cheap but adds lag.
*Line smoothing* (Drawing, 0–10, default 2) smooths the drawn geometry instead: a Gaussian blur of the polyline along its own
length (σ grows with the slider, independent of how many points the tracker produced; the ends stay pinned) plus quadratic
curves through the segment midpoints. It applies live to everything on the wall, to the
preview and to snapshots, and costs no lag.

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
*show detection mask*.

**Anti feedback loop.** The projected drawing itself can look like the laser to the camera (a green stroke, or the green parts
of *rainbow*). The control window therefore renders what is being projected into a small projector-space canvas every frame,
keeps only the pixels whose colour would pass the laser test, warps that through the calibration into camera space and
ignores candidate pixels there (blue in *show detection mask*). Strokes in other colours are not masked, so you can draw over
them; the freshest 400 ms of the stroke being drawn are excluded because that is where the real laser dot is. Toggle with
*ignore our own projected strokes*. Particle effects (drips, sparks, flames) are not part of the mask.

## Files

- `server.mjs` – static server (no dependencies)
- `public/index.html`, `public/demo.js` – landing page with the mouse demo
- `public/app.html`, `public/app.js` – control UI, camera loop, detection, calibration, laser menu, snapshots
- `public/projector.html`, `public/projector.js` – fullscreen drawing surface, receives messages via `BroadcastChannel`
- `public/scene.js` – the renderer (brushes, effects, menu, board) shared by projector, demo and snapshots
- `public/game.js` – tic-tac-toe engine
- `public/shared.js` – homography math, settings, menu layout, brush rendering

MIT licensed.
