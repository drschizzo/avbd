# Loop Lab — satisfying physics loops with AVBD on WebGPU

Build a scene (or a chain-reaction machine), bake up to 30 seconds of **Augmented Vertex Block Descent** rigid-body
physics on the GPU, and export a **seamless looping MP4**.

```bash
npm install
npm run dev
```

Requires a WebGPU browser (recent Chrome / Edge on desktop).

## What's inside

| Layer | What it does |
| --- | --- |
| `src/engine/` | GPU AVBD solver from [jure/webphysics](https://github.com/jure/webphysics) (MIT), vendored and extended (see below) |
| `src/sim/baker.ts` | Fixed-step bake; every frame is recorded **on the GPU** into a compact history buffer (16 B per body per frame: float32 position + 10:10:10:2 "smallest three" quaternion). No readback, ever. |
| `src/sim/baker.ts` (pacing) | While the page is visible the bake runs in slices, one per rendered frame (preview capped at 60 fps while baking, ≤ 2 slices queued on the GPU), sized by AIMD on the frame interval: the preview streams fluidly and the bake takes the remaining GPU time. Hidden pages fall back to throughput batching. |
| `src/sim/batchedCompute.ts` | Collapses the ~200–350 compute dispatches per frame into one command buffer (uniform/attribute uploads replayed in order through a staging ring). |
| `src/render/bodies.ts` | One instanced draw per shape. The vertex shader fetches poses from the history, interpolates frames, applies loop transitions and rebuilds rounded boxes with a constant bevel for any size. |
| `src/render/stage.ts` | WebGPU renderer, custom studio environment, VSM soft shadows, GTAO, bloom, depth of field, vignette/grain, MSAA/SMAA/FXAA. |
| `src/scene/` | Scene document, entity catalogue (schemas drive the UI), builder, palettes, presets. |
| `src/export/video.ts` | Offline, frame-exact export: supersampled render → WebCodecs H.264 → MP4. |

### Liquids (MLS-MPM)

`src/fluid/` adds a GPU liquid next to the AVBD rigid bodies (raw WGSL on the same device):

| File | What it does |
| --- | --- |
| `fluidBuild.ts` | Seeds particles (8 per grid cell) from *Water block* and *Water source* entities, sorted by spawn frame, and fits the simulation box. |
| `fluidSolver.ts` | MLS-MPM: P2G (APIC momentum), P2G (Tait pressure + viscosity), grid update, G2P, with fixed-point atomics. Scenery is rasterised once into a nearest-collider map; moving bodies are re-rasterised every frame straight from the engine buffers. Dynamic bodies receive the momentum the liquid loses against them **every substep** (two-way coupling: floating, sinking, being swept away). |
| `fluidRender.ts` | Screen-space surface: sphere impostors → view depth, additive thickness, bilateral depth smoothing, normals from depth, refraction + Beer–Lambert absorption + Fresnel reflection + studio highlights, and a sphere proxy on a shadow-only layer. |

The liquid history is 8 bytes per particle per frame (16-bit position in the box, speed, alive bit), allocated
directly on the GPU and adopted by three.js (no CPU mirror). Liquid follows the loop transitions (rewind, shrink;
`sink` opens the floor so the water drains). *Settle pre-roll* (Scene → Liquid) relaxes resting pools before frame 0.

Lessons that cost time: boundary conditions must cover the grid nodes that drive the particles resting on a wall,
or they pancake into it (~20 % volume loss and jets climbing the walls); a one-node collider map leaks at corners
unless push-out looks at the 8 surrounding nodes; coupling impulses must update the collider velocity between
substeps or heavy bodies bounce off the surface.

### Interactive course — « Anatomie d'un moteur physique »

The **? Comment ça marche** button in the top bar replaces the editor with a
~26-minute guided course (in French) on how a physics engine works, built the
same way as the raymarching course in the sibling `shader2` project.

| Piece | What it does |
| --- | --- |
| `src/course/tour.ts` | The content: 33 chapters in 5 modules, 93 captions, 10 prediction questions, 11 hands-on pauses with measurable missions. One timeline, so the learner can scrub anywhere. Captions carry code with **draggable values** (`{{key\|min\|max\|step}}`). |
| `src/course/mini.ts` | A **2D rigid-body engine written for the course**: the same scene can be run with no solver, with sequential impulses (PGS), with a plain penalty (VBD) or with the full AVBD (λ + rising β). It is the only way to show what happens *inside* one time step. `trace` records every iteration. |
| `src/course/diagrams*.ts` | 30 animated canvas diagrams. The solver ones do not illustrate an idea — they run `mini.ts` and plot what actually came out (convergence curves, residual penetration against stiffness, λ and k per iteration). |
| `src/course/simcache.ts` | Those plots are a dozen simulations each, so they are recorded once and replayed, with a per-frame budget so the page never stalls while a curve fills in. |
| `src/course/scenes.ts` | 16 short 3D scenes (5 s at 30 fps) run by the **real GPU engine**. Changing a solver setting in a mission re-bakes the scene in a fraction of a second. |
| `src/course/lab.ts` | The workshop: 8 challenges where the learner writes a piece of the engine in JavaScript (the integrator, the inertial prediction, a constraint value, the one-sided contact force, the dual update, the Coulomb cone, the velocity update, graph colouring). Each one is plugged into a readable solver and compared frame by frame against the reference. |
| `src/course/mini.selftest.ts` | `courseSelfTest()` in the dev console: 8 physics assertions on the 2D engine plus a check that every challenge accepts its solution and rejects its starter. |

Things that cost time here, and are worth knowing:

- The two engines use **the same letters for different quantities**: the mini
  engine's `beta` is a penalty *growth factor* (≈ 5), the GPU engine's is a
  penalty *value* (≈ 1e4). `DOC_KEYS` in `tour.ts` deliberately lists only the
  parameters that mean the same thing in both; writing β across destroyed every
  3D scene before that was caught.
- AVBD's dual update must run **after every sweep**, not once per substep: with
  one update per substep a hard impact keeps most of its penetration and gives
  it back as a bounce (a ball dropped from 2 m hopped 10 cm with restitution 0).
  It then needs a dead band, or extra iterations keep pumping λ until it throws
  the body into the air.
- The penalty ceiling matters more than its growth rate: above roughly 30 × M/h²
  the block descent stops converging. For the course's units that is `kMax = 1e5`
  — the same wall the GPU engine hits at β = 1e6 in float32.
- Class names are shared with the editor's stylesheet (`.left`, `.right`,
  `.top`, `.seg`, `.time`), and `body.course-on` hides several of them. Course
  elements are prefixed; the quiz verdicts use `is-right` / `is-wrong` because
  `.right` made the correct answer invisible.
- `App.persist` is switched off while the course runs, so its scenes do not
  replace the user's saved document nor appear in their undo history.

### Guided tutorial — « ▶ Tutoriel »

Next to the course, a hands-on tour of the editor itself (in French, ~15 min),
opened by **▶ Tutoriel** in the top bar and offered once on the first visit.
Unlike the course it does not take over the window: the editor stays fully
live, and a floating card points at the part of the interface it talks about.

- **Part 1 — the interface** (10 steps) on the *Catapult Machine* preset:
  presets, bake, playback and scrubbing, Shot / Free camera, selection, the
  Object tab, the gizmo and undo, the Machine tab, the other tabs.
- **Part 2 — build a machine** (18 steps) on *Machine Workshop*: a ramp, a ball
  set to the right size and density, a domino run drawn with ✎ Draw, a pyramid,
  then the bake, the Machine diagnosis, Test ×5, clip length and loop, palette,
  camera motion, export.

| File | Role |
|---|---|
| `src/tutorial/steps.ts` | The content. Each step names its target (`data-tut` attributes in `ui.ts`), the task, a `done()` test read from the app state, hints, and a « Faire pour moi » action. Points of the scene (where to drop the ramp, A → B for the dominoes…) are computed from what the learner actually built. |
| `src/tutorial/index.ts` | The card, the spotlight and the 3D markers; picks a spot for the card that hides neither the target, the markers nor the selected object. Saves the step; on leaving, offers to bring back the scene the learner had before. Dev console: `tutorial.go(i)`, `tutorial.list()`. |

The reference machine was tuned in the real engine: the pyramid needs
`density ≈ 0.3` (at 1 the last domino only comes to lean on it) and its near end
≈ 0.3 × domino height past the last domino. `App.holdEdit` keeps the editor in
edit mode after a bake while the learner places parts.

### Seamless loops

The clip must end exactly where it starts. Each scene picks a transition:

- **reassemble** – initial bodies fly back to their starting pose (staggered, with an arc); spawned bodies pop out.
- **shrink** – everything pops out at the end and grows back in at the start.
- **sink** – the ground becomes permeable and everything sinks through the floor.
- **boomerang** – the clip plays forward at true speed, slows into the apex (*Apex slow-down*, s), then
  rewinds, accelerating up to *Rewind speed* × the forward speed and landing softly on frame 0. Only the
  forward span is simulated (`src/sim/loopTime.ts`), so a fast rewind leaves more of the clip to real physics.
  Best for destruction: the way back is the collapse played backwards, so nothing cuts through anything.
- **continuous** – for steady processes (a drum, a mixer, a stream, an hourglass). The clip is simulated
  twice: a warm-up take from the scene as built, then the recorded take starting exactly where the warm-up
  ended (periodic kinematics are back at their t = 0 pose). Both takes end at the same moment of the
  cycle, so the last `outro` seconds of the warm-up are kept (`BakeResult.tail`) and each body glides from
  its own trajectory onto the warm-up trajectory of an **interchangeable twin** (same shape, size, finish;
  `src/sim/loopMatch.ts`): at the seam, frame D shows body *i* where frame 0 shows its twin — the same
  picture. Twins are paired by a greedy + pairwise-swap assignment on the positions halfway through and at
  the end of the blend; boxes also take the box symmetry (up to 24) closest to their attitude, spheres keep
  their spin. A twin of another colour may be used when it spares a trip of a couple of body sizes (the
  colour cross-fades), and a twin too far to glide to is reached by a hop (shrink, pop up there).
  Emitters are recycled: spawned bodies exist from the start, parked far below, and each spawn teleports
  its body to the emitter — so a stream is already flowing at frame 0. Bake time doubles.
  Design tips: put the seam where the process is calm (the hourglass seam is the sand at rest before the
  turn), use few colour classes, and keep everything in play (a lid on the mixer).

Purely kinematic scenes (the *Pendulum Wave*: pendulum *n* swings `cycles + n` times per loop, with the
length real gravity gives that period) loop exactly with no transition (`none`).

Kinematic motions (spin, swing, slide, gate) and camera moves are periodic over the clip
(orbits always make whole turns). Entity builders can also give individual bodies their own
kinematic motion (`LocalBody.motion`): the Galton gate, the Hourglass flip, the Tumbler drum and the
Pendulum wave use it. The hourglass is symmetric under its 180° flip, so the turned glass at the end of
the clip is indistinguishable from the upright one at the start.

### Building machines (chain reactions)

The editor is made for Rube Goldberg style machines: parts are placed, drawn and copied quickly, and every
bake is checked step by step.

| Tool | How |
| --- | --- |
| **Drop-in placement** | A palette tile (or a paste, or a saved gadget) follows the cursor over the scene and sits on whatever is under it: floor, a shelf, the side of a box. Click drops it, ⇧ snaps to a 0.25 m grid, right-click / Esc cancels. |
| **✎ Draw** (D) | Drag in the viewport to draw a path, then pick what it holds: a **domino run**, a **marble row**, a **block row**, or a track — **rail** (floor + side walls), **track** (flat strip) or **guide wall**. Rows stand on what they were drawn on; a rail drawn flat on the floor gets a gentle 6° fall (*Drop*). Blue dots are control points (click one, move it with the arrows, Del removes it); *Reshape* swaps in a line, arc, S-curve, zigzag, circle or helix. |
| **Work plane** (P) | XY / ZY / XZ: drawing and placing land on the plane, the gizmo keeps to it, a grid shows it. `[` `]` move it by 0.25 m, ⊡ looks at it square on. Build a machine as a vertical slice, then add depth. |
| **Selection** | ⇧-click adds or removes, ⌘A selects all. The gizmo moves and turns everything selected about its centre. **Groups** (⌘G / ⇧⌘G): clicking a part selects its group, ⌥-click a single part. |
| **Copy / paste** | ⌘C / ⌘X / ⌘V (works across scenes: the clipboard is kept in local storage), ⌘D duplicates, *Repeat…* makes a row or a ring of copies. |
| **Ports** | Orange rings at the ends of ramps, rails, rollers and cups: moved parts snap end to end (⌥ moves freely), and a drawn track starts and ends on a nearby port. |
| **⤓ Drop** (End) | Lowers the selection onto the surface below; on a drawn path, every point. **⌖** (F) frames the selection in the free camera. |
| **My gadgets** | *Save as gadget…* stores the selection in the palette (local storage); placing it again makes a new group. |

Gadgets (`src/scene/gadgets.ts`): **Seesaw** (a catapult when loaded, can rest on the floor), **Ramp**, **Hammer**
(a hinged pendulum, optionally held by a catch that pulls away at *Release at*), **Free wheel** (paddles hinged on an
axle), **Piston** (a kinematic pusher: the reliable way to start a machine at a given time), **Cup** (static target,
loose box, or hanging and tipping), **Rollers** (a powered conveyor of spinning balls, rounded to whole turns per
loop), **Sensor** (a test zone, invisible in the render). Hinges are two spherical joints on the axis: the engine has
no revolute joint.
The **Wrecking ball** can also start *latched*: a level rigid rod, the ball resting on a bar whose near end stands
on a thin loose prop. The load is purely vertical so it holds indefinitely; topple the prop (a domino, a giant) and
the ball swings: a release set off by the machine itself rather than by a timer.

**Machine tab** (`src/sim/analysis.ts`): after every bake the history is read back (≈ 30 samples/s, ≤ 48 MB) and
each object is judged: when it was first set in motion (moved by a quarter of its size or turned by 20°), whether a
row fell to its last piece (a red ring marks the first piece that never moved, a red mark on the timeline when), when
each sensor zone was reached, when the last thing stopped moving (windowed: 3 cm or 9° in half a second, so slow creep
does not count) and whether that is before the loop transition. Objects marked ○ are decor and not required to move.
*Test ×5* bakes the machine five times, each nudged by < 1 mm (plus the GPU's own run-to-run differences: the solver
is not bitwise deterministic) and shows how often each step held; *Bake until it works* stops at the first run where
everything held and keeps it for export. *Solo* bakes only the selection, to tune one part alone. Selected objects
show their trajectories.

Lessons that cost time:

- Contacts are inelastic, so a rail made of short boxes must never present a step **up** at a seam: each piece laps
  forward over the next one only and sits a hair lower. A marble on a curved rail still settles to a terminal speed
  (it rides the outer wall), so a spiral takes ~1.5 m/s: plan the clip length for it.
- A domino run cannot push a heavy body: a small domino leaning on a 20× heavier block just rests on it, and one
  pressing down on a heavy ball pins it. Amplify in steps (≈ 1.3× bigger, ≤ 3× heavier each).
- A catapult throws with ±10 % spread run to run; catch with a backboard over a wide basket rather than aiming.
  Keep the catch inside the basket's envelope, though: a wider funnel clipped the ball on its way *up*.
- Amplifying dominoes: ≈ 2× heavier per step is safe. At 3× and more the lighter one leans on the heavier,
  its foot slides forward and it ends up lying *under* it.
- A domino row is laid every step from its start, so it can stop up to a step short of its drawn end: place what
  it must hit from the last domino actually built (`buildPath`), not from the path's end point.
- A loose prop pushed along the bar it supports topples *under* the bar and keeps holding it; a near-frictionless
  bar slides away by itself within seconds (solver noise) and, once free, skates across the floor.

**Follow camera** (`src/sim/follow.ts`, camera motion *follow*): after each bake the machine check's sampled
poses (~30/s) tell where things move. Each object pulls the camera toward its moving bodies, weighted by its squared
speed and by novelty (what has just set off counts more than what has been moving for a while), smoothed over time
with activity weights (quiet moments hold the last shot) and looked at slightly ahead (*Look ahead*). The shot keeps
the angle of the *Position → Target* camera but comes as close as *Closeness* allows, backing off when the action
spreads, never farther than the wide shot. The camera reads the simulated time, so a boomerang's rewind brings it
back along its path; other loops glide back to the first shot. *Camera follows* (Object tab) leaves an object out
(the Grand Machine's hourglass).

**Grand Machine** (`grandMachine()` in `src/scene/machines.ts`) chains nearly all of this into one 24 s run: a
hammer taps a marble down a spiral column, a growing domino row fires the catapult into a funnel, a rail carries the
ball to a roller conveyor under a bead curtain, a free wheel and a ramp set it on the floor, and a fork splits the
last row into a domino spiral and a giant cascade that unlatches a wrecking ball into a ring tower. It holds 5/5 on
*Test ×5*; the hourglass is the only part not on the chain (it turns with the start, as a clock).

### Engine changes (vs. upstream webphysics)

- Kinematic bodies: static bodies advance along a prescribed velocity, so contacts carry them correctly (paddles, gates, sweepers).
- Breakable joints (`fracture` force threshold, stored in the joint stiffness record).
- Fixed joints keep the relative orientation the two bodies had when the joint was made (upstream recorded it but the
  angular constraint drove the bodies to *equal* orientations, which folded any ring of turned parts such as a wheel).
- `stepFixed()` for deterministic baking, `setGravity()`, `dispose()`.
- Bug fix: brute-force pair decoding dropped pairs `(0, j)` when `sqrt` rounded down (Metal), letting bodies fall through the ground.
- Bug fix: `clearScene()` zeroed its buffers on the CPU but the upload could leave the previous scene on the
  GPU: once an attribute has update ranges three.js writes only those, and the next scene adds some at once
  (each joint flags its pair as non-colliding). Stale "ignored pair" bits then let unrelated bodies of the
  next bake pass through each other (dominoes slipping under the next one, a marble through a row) - only
  after a scene with joints had been baked in the same session. The cleared buffers are now uploaded whole.
- **Body solve performance (~6–15× faster bakes):**
  - the local 6×6 system is accumulated and solved as 3×3 blocks (`mat3x3f`, Schur complement) instead of dynamically indexed `array<array<f32, 6>, 6>`, which Tint's loop guards push to stack memory on Metal;
  - *wide* solve: one 32-lane workgroup per body, constraints spread over the lanes and reduced in shared memory (one thread per body walked 40 contacts serially, latency bound); the commit is fused in place (`AvbdStateStage.wideBodySolve`, set it to `false` for the original Jacobi solve + commit path);
  - one solve kernel instance per color, so no uniform changes between dispatches (each one split the compute pass);
  - local-diagonal inertia variant by default: the generic one refreshed the derived world inertia every iteration, from quaternions that do not change within a substep, and then only used its local diagonal.

- **Rolling spheres sank through floors** (Galton beads vanished): contact arms were rotated with the
  body during the solve, so a fast-rolling sphere's arm tilted off the normal and the linearised
  constraint reported ~r·θ² of false separation per frame. Contact generation now flags sphere sides
  (`armB.w`) and the solver keeps their arm world-fixed along the normal (`±n·r`).
- Air drag (`setDrag`, `physics.drag`): implicit linear/angular velocity damping in the velocity
  finalize pass. The Galton board uses it as a viscous board: without it, inelastic frictionless
  contacts let beads keep their sideways momentum along the lattice diagonals and the histogram
  comes out flat instead of binomial.

Rendering fixes:

- Body materials include the history/edit buffer identities in their program cache key. three.js
  caches node programs (and their bindings) by graph structure only, so after a re-bake with the same
  body layout the playback kept reading the *previous* bake's buffer.
- Offscreen captures (`Stage.renderOffscreen`) advance three's node frame before rendering: pass nodes
  render once per frame id, which only advances in the rAF loop, so consecutive export frames between
  two ticks (or any capture in a hidden tab) reused the previous image.
- Bakes in a hidden tab batch more work per yield (GPU completion callbacks are throttled to ~180 ms).

Dev tools: `machine(key)` bakes a preset and summarises its machine check, `soloN(['prefix', ...])` solos entities by name, `traj3(name, nth, every)` samples a body's path, `view(name, pos, target, w, h, t?)` saves a frame from any camera to `.debug/`; `bench('pyramid')` / `benchAll([...])` in the console time steady-state steps, `loadTest('pyramid', paced?)` measures preview fps while a preset bakes (dev server only); `app.baker.batcher.profile = true` records per-kernel GPU timestamps into `app.baker.batcher.profileTotals`. `seam(key)` measures the visual jump across the loop point, `shots(key, times)` saves frames to `.debug/`, `hist(frame)` reads baked poses back, `evalPreset(key, times?)` bakes a preset and returns its seam metrics, `matchStats()` (continuous loops) reports how far bodies travel to their twins (p50/p90/p99, hops, colour swaps).

Engine code © 2026 Jure Triglav, MIT licence (`src/engine/LICENSE.md`).
AVBD: Giles, Diaz, Yuksel — *Augmented Vertex Block Descent*, SIGGRAPH 2025.
