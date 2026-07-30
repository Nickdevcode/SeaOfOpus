# 🪵 Wooden Plank — the repair plank

The plank the pirate carries across his chest to patch a hole in the hull, in the style
of *Sea of Thieves*. **Modeled and textured entirely by script** in Blender — you can
wipe everything and rebuild it with one command.

![turnaround](preview/turnaround.png)

---

## 📦 What is in here

| File | What it is |
|---|---|
| `plank.blend` | The complete scene (mesh + materials + textures) |
| `export/SM_Plank.glb` | Binary glTF — three.js, Godot, web |
| `export/SM_Plank_web.glb` | The same, with the textures in WebP: **64 KB** against 378 |
| `export/SM_Plank.fbx` | FBX — Unreal, Unity, Maya |
| `textures/T_Plank_*.png` | 1024² atlas — base color, roughness, normal |
| `scripts/` | The whole pipeline in Python |
| `preview/` | Check renders |

> [!note] `SM_`, not `SK_`
> *Static Mesh*. The plank has no skeleton — the prefix is the same vocabulary the
> character uses with `SK_Pirate`, just on the other side of the fence.

---

## 📊 Technical specification

| Item | Value |
|---|---|
| **Triangles** | **480** |
| **Vertices** | 242 |
| **Faces** | 224 quads + 32 tris, **zero n-gons** |
| **Mesh** | closed: 0 boundary edges, 0 non-manifold, 0 flipped normals |
| **Nominal dimensions** | **1.15 × 0.22 × 0.045 m** |
| Bounding box | 1.150 × 0.221 × 0.053 m |
| Real width (ring to ring) | 213.2 – 219.6 mm |
| Real thickness (ring to ring) | 44.8 – 47.2 mm |
| **Material** | 1 (`M_Plank`, single atlas) |
| **Texel density** | **8.83 px/cm @ 1024²** |
| Maps | Base Color, Roughness, Normal |
| **Scale** | 1 unit = 1 meter, transforms applied, **origin at the center** |
| GLB weight | 378 KB (authoring) / **64 KB** (WebP) |

> [!note] 480 tris is 5.4% of the character
> The whole pirate costs 8,960. A plank has to cost a fraction of that, and every
> triangle here is paying for silhouette: chamfer, bow, edge wobble and the skewed cut of
> the ends. None was spent on uniform subdivision.

> [!warning] The bounding box is **not** the thickness of the piece
> The box gives 53.2 mm and the plank is 45. The difference is the bow: the middle of the
> piece rises 6 mm, and the box adds that in. Anyone who wants the tape-measure figure has
> to measure **ring by ring** — which is what `build_plank._section_sizes` does, and where
> the table's 44.8–47.2 mm come from.

---

## 📐 Where the measurements come from

Nothing was chosen by eye. Every number has three cross-checked sources — the game, the
character and real naval carpentry — and they all agree.

| Measurement | Value | Why |
|---|---|---|
| **Width** | **0.22 m** | It is *exactly* the width of the Sloop's deck planking: `HullGeometry.ts` maps `DECK_BAND_TILE = 1.76 m` over a texture of `planks: 8` → 1.76 / 8 = 0.22. The player walks on that width for the whole game. |
| **Length** | **1.15 m** | A grip of ~0.58 m (the character is 0.50 m shoulder to shoulder) + 0.28 m of overhang at each side. A 5.2:1 ratio, inside the 5:1–6:1 range measured on the game's inventory render. |
| **Thickness** | **0.045 m** | Real sloop hull planking: 1½"–2" (38–50 mm). It also matches the ratio in the official render: thickness between ⅕ and ¼ of the width. |

External references backing the numbers: the *shole* in the **US Navy damage control**
manual (minimum 1" thick, 8"–12" wide), the formal definition of "plank" (above 1½"; DIN
68252 requires 40 mm) and historical deck planking (6"–12" wide, 2½"–3½" thick).

**It checks out on weight:** 0.0114 m³ × 700 kg/m³ (oak) = **8 kg**. A two-handed load. A
whole stock plank, 2.44 m long, would come to 17 kg and nobody carries that across their
chest — hence the short cut.

![scale](preview/scale.png)

> [!note] The pirate appears in the rest pose, on purpose
> The glTF importer applies the **first animation in the file**, and `SK_Pirate_web.glb`
> carries five clips. The first version of this image came out with the character in the
> middle of a jump: floating, no foot on the ground, useless as a ruler.
> `pose_position = "REST"` returns the bind pose, which is deterministic and has the sole
> at Z = 0. The ruler on the floor is 1 m in 10 cm bars.
>
> The character's GLB is opened **read-only**. It is another asset's deliverable; nothing
> in this pipeline rewrites it.

---

## 🪚 What keeps the piece from being a stretched cube

The art rule Rare applies in *Sea of Thieves* is **"realistically wonky"**: the object has
to look used, never fresh from the factory. Five things do that here, and **none of them
costs a triangle** — they all live in vertices the topology already needed to have.

| # | What | How much | Why |
|---|---|---|---|
| 1 | **Wavy long edge** | ±4 mm | It is the strongest observation from the official render: no line on the plank is straight. The piece is hewn, not planed. |
| 2 | **Ends cut on a skewed plane** | 6.5° and −4° of yaw, different angles on the two | A shipboard handsaw does not cut square. A clean cut, but crooked — not splintered. |
| 3 | **Chamfer on all four long edges** | 4 mm | What a hand plane takes off in one pass. It is the band the *pointiness* lightens, and it is what draws the piece's outline against the background. |
| 4 | **Bow + cup** | 6 mm along the length, 2.5 mm across the width | Every sawn plank has it. The cup moves **both** faces to the same side, which is how wood really warps. |
| 5 | **Faceting by noise** | 1.2 mm | The same function as the character's (`piratelib.facet`). Subliminal from a distance, breaks the light up close. |

On top of that: a 3% taper from one end to the other, 1.8° of twist along the length and a
3 mm bevel around both ends.

![topology](preview/topology.png)

The topology is a *sweep*: fifteen cross sections of sixteen points stitched with quads,
exactly the engine that builds the character (`piratelib.sweep`). Triangles only on the
two caps, fanned out from the centroid.

> [!note] Why the origin sits at the center
> It is the piece's balance point — what the hand holds and what the physics will use as
> the center of mass when the plank is dropped on the deck. With the origin at one end, the
> plank would orbit the fist instead of turning in it.

---

## 🎨 The texture

**Procedural** materials, baked to an atlas. Two shaders: the sawn face and the **end
grain**. Separating them is not fussiness — wood cut across the grain is another material:
it drinks more light, it is more matte and it shows the rings in arcs instead of long
bands.

![detail](preview/detail.png)

What decides the look, in order of importance:

1. **Restraint.** Rare's rule is literal: the asset carries *"only enough detail to give
   the impression of what it is"*. The official render of the plank has **two to four wide
   bands** across the entire face and almost no fine detail. A photographic oak grain here
   would be technically better and stylistically wrong.
2. **Object space, not UV.** The whole pattern is sampled in object coordinates. The grain
   runs along the length of the piece regardless of how the islands fell — and that frees
   the UV packer to optimize area instead of preserving an alignment nobody would use.
3. **Pointiness on the edges.** The same term that gives the character's worn leather gives
   the sanded edge of the chamfer here.
4. **Knots that go through the piece**, with the grain opening into a cathedral as it
   passes around them.
5. **The narrow face darker than the wide one** — a radial cut against a tangential one.

### The palette

| Role | Hex (sRGB) | Note |
|---|---|---|
| Body | `#BE8355` | Tan/ochre, hue 25°, S 0.55 |
| Dark grain | `#96603A` | One step of value, not a contrast |
| Knot | `#5E3A22` | The only low value on the piece |
| Worn edge | `#DCB98F` | Lighter **and** desaturated |
| Sawn end | `#A5714B` / rings `#6F4A2E` | |
| *(reference)* Sloop deck | `#8F704F` | `ShipMaterials.ts`, hue 31°, V 0.56 |

The plank is **freshly sawn** wood: it goes up in value and saturation and down in hue
relative to the salt-scoured deck. That is why it catches the eye in the hold without
clashing with the ship.

> [!warning] The submerged reference lied about the color
> The first palette came from the game's screenshot — which is **underwater**, with a cyan
> filter over everything. Sampled there, the plank gives `#964627`: a deep orange. Copied
> as albedo, that became a salmon-colored plank that read as plastic. Water eats the green
> and the blue, so everything down there *looks* more saturated than it is. What the
> reference does prove is the **relationship** (the plank is much warmer and lighter than
> everything around it) and the **frequency** (wide variation, an almost flat surface). The
> absolute value came from the palette the game already has.

### The maps

| Map | Suffix | Space | Present? |
|---|---|---|---|
| Base Color | `_D` | sRGB | ✅ |
| Roughness | `_R` | Non-Color | ✅ |
| Normal | `_N` | Non-Color | ✅ |
| Metallic | `_M` | — | ❌ wood is a pure dielectric; it goes in as the scalar 0 |
| Ambient Occlusion | `_AO` | — | ❌ **measured**: mean occlusion 0.9998, 1st percentile at 1.0 |

> [!warning] Base color is baked by EMIT, not by DIFFUSE
> The trap is documented in `PirateCharacter/README.md` and the remedy is reused from
> there, imported from `finalize.py` instead of copied over. There is no metal here, so the
> symptom would be different — the `DIFFUSE` pass would bring the color *after* the light
> calculation, and not the raw value the engine expects — but the cure is the same.

> [!warning] The AO map's minimum lies
> The measured minimum was **0.039**, which would suggest very deep occlusion on a piece
> that does not have a single recess. Those are the pixels at the **edge of the UV island**,
> where the occlusion ray leaves the surface. A mean of 0.9998 and a 1st percentile at 1.0
> tell the true story: the map is white with a fringe. That is why the cutoff is on the
> **mean**, and why `_AO` is not shipped.

---

## 🧵 UV and texel density

**1024², and not 4096².** Measured, not estimated.

| | Plank | Character |
|---|---|---|
| Surface area | 0.5986 m² | ~19 m² (with interior geometry) |
| Atlas | 1024² | 4096² |
| Atlas usage | 44.5% | — |
| **Density** | **8.83 px/cm** | 8.69 px/cm |
| Map memory | ~350 KB as PNG | ~28 MB |

The 44.5% is not the packer being sloppy: the wide face is 5.2:1, and **eight
configurations** of `smart_project` + `pack_islands` (CONCAVE / CONVEX / AABB, margins of 3
to 6 px, angle limits from 45° to 89°) all landed between 39.9% and 44.7%. It is the
ceiling of that shape inside a square atlas.

**Why 8.83 px/cm is enough here**, even though a first-person prop lives in the
1024–2048 px/m range: what the texture carries is a wide gradient. The grain band is ~6 cm
(53 texels) and the chamfer highlight, the smallest feature on the map, is 4 mm
(3.5 texels). There is no fine detail to lose — *Sea of Thieves*' stylistic restraint is
exactly that.

> [!note] The two levers, if the edge ever reads soft in first person
> 1. `plank_spec.ATLAS = 2048` — doubles everything, the pipeline rebuilds with nothing
>    else, and it costs 4× the memory.
> 2. Cutting the wide faces' islands in half along the length, so the packer can use two
>    columns. It is worth **+21%** of density (8.83 → ~10.7) at the price of a seam down the
>    middle of the face. It was not done because, with the whole pattern in object space,
>    the seam does not show in the color — but it also does not pay the complexity price for
>    a texture with no high frequency.

---

## 🔁 Rebuilding from scratch

**Always headless.** There is a GUI instance of Blender open in the project with the
character; nothing here may touch it.

```bash
"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe" \
  --background --python Props/Plank/scripts/build_all.py
```

Individual stages, in whatever order they come up:

```bash
... --python build_all.py -- geo mat atlas
... --python build_all.py -- preview
```

Total time: **~70 s**, of which 60 are Cycles rendering the previews. The geometry and the
materials take 0.01 s each.

### The scripts

| Script | Role |
|---|---|
| `plank_spec.py` | Every measurement and color, each with its provenance beside it |
| `build_plank.py` | The mesh: sweep, wobble, bow, skewed cut of the ends |
| `plank_materials.py` | The two procedural shaders + per-face assignment |
| `plank_finalize.py` | UV, atlas bake, final material |
| `plank_export.py` | Pre-export checklist, writing `.blend` / FBX / GLB / web GLB and **checking the GLB it wrote** |
| `plank_preview.py` | The four check renders |
| `build_all.py` | Entry point |

> [!note] The plank imports the character's engine
> `piratelib.py` (sweep with *parallel transport*, superellipses, faceting) and the delicate
> parts of `finalize.py` (the Emission detour, the texel density measurement) and of
> `preview.py` (camera, lights, engine choice across versions) are **imported** from
> `PirateCharacter/scripts/`, not copied. It is a deliberate coupling: there is a documented
> bake trap in this project, and it has to exist **exactly once**.
>
> The price is that renaming the character's folder breaks the plank — which is why
> `build_plank` fails with an explicit message if it cannot find the path. When the third
> prop arrives (the bucket), those functions move up to a common place instead of living
> inside one asset's folder.

> [!note] Why the modules are prefixed `plank_`
> The character's scripts enter `sys.path` alongside these. Two `proportions.py`, two
> `export.py` or two `preview.py` on the path would make `import` pick the wrong one
> **without warning**.

---

## ⚠️ The traps this asset dug up

**Blender's Wave does not count cycles the way it looks like it does.** The wave is
`sin(coord · Scale · 20)`, so the period in meters is `2π / (20 · Scale)`. At Scale 18 —
the initial guess — that comes to 17.5 mm: **twelve bands** crossing the plank's 22 cm.
Rendered, it turned into **corduroy**: too regular a stripe to be wood and too fine for the
atlas to hold. At 5.0 the period rises to 63 mm and ~3.5 bands are left, which is the
reading from the reference.

**The bump wanted to be ten times bigger than it should.** The first version used 0.9 mm
with a strength of 0.5 and the plank came out **corrugated**, with the highlight in bands —
every ring became a gutter. Weathered wood has *tenths* of a millimeter of relief between
spring and summer growth. 0.25 mm at a strength of 0.3 is what you see up close and what
vanishes from a distance.

**The knot's radius is not in meters.** The disc's window went in as `RADIUS / SCALE`, by a
wrong analogy with world units. The Voronoi's `Distance` output already comes in the space
multiplied by the scale — a cell's radius is worth ~0.5 in there. With the divisor, the
window sat at 0.017 and **no pixel got through**: the plank came out without a single knot
and nothing in the log complained.

**And the knots' Voronoi has to be 2D.** With the field in 3D, the seeds spread through the
thickness as well, and the plank is a 4.5 cm slice in a space of 14 cm cells: the expected
number of knots on the whole piece came to **half of one**. In 2D the knot becomes a
cylinder that goes through the board — which is literally what a knot is, the branch cut
right through — and it shows up on both faces, in the same place, for free.

**The skewed cut folded the geometry.** The end's offset reaches 30 mm across the width,
while the bevel's ring sits 13 mm from the end: moving only the end ring, the more recessed
corner passed **behind** the bevel, the face turned inside out and a step of torn-off slice
appeared at the corner. A saw cuts a plane, not a ring — the end's two rings move together
now.

**And the worst of all: `os.path.basename` lied about the texture's path.** After saving the
`.blend`, Blender rewrites the images' paths into its own relative form —
`//textures\T_Plank_D.png`. On Windows, `ntpath` reads those first two characters as the
start of a **UNC path** (`\\server\share`), swallows the entire string as the "drive" and
returns `basename() == ""`.

The chain of damage, all in silence: the target became the `textures\` *folder*;
`os.path.exists` said yes, because a folder exists; the code "fixed" the path by pointing
the image at a directory; `reload()` emptied the pixels; and the web GLB came out with
**three textures and one image** — base color, roughness and normal all in the same file.
Exit code zero, a one-line WARNING lost in the log, and a 35 KB file that opens without
complaint in any viewer.

Two fixes, and the second is the one that matters:

1. `bpy.path.abspath()` **before** any `os.path`, and `isfile` instead of `exists`.
2. **`inspect_glb`**: the pipeline now opens the GLB it just wrote, reads the JSON block and
   fails if any texture is missing its image. Checking the **artifact**, and not the
   process, is the only check that does not lie — it is what proved the fix, and it is what
   keeps this bug from coming back unannounced.

> [!warning] The end grain was not dark; the scene was
> In the first renders the end grain came out dark brown, and the natural reading was "the
> end grain's material came out too dark". Measured on the baked atlas, the end grain comes
> out at `#BA8F67` — **lighter** than the face. What was wrong was the lighting: the trio of
> lights inherited from the character all come from above, behind and the left, and a face
> looking at +X received a contribution from exactly one of them. **Debugging the shader
> over that would have ruined a material that was correct.** The lesson goes beyond here:
> before touching the material, measure the map.

---

## 🧭 Limitations and decisions worth revisiting

- **There is no attachment point, no rig and no hands.** That was a scoping decision: the
  plank was modeled, textured and delivered for approval; where it attaches to the character
  comes later. When it does, the natural candidate is an *empty* at the origin (which is
  already the center of mass) and a `plank_socket` bone in the right hand.
- **No LODs.** At 480 tris the piece is practically a LOD already; what would make a
  difference in a stack of planks is *instancing*, not LOD.
- **No variants.** Every plank comes out identical — same knots, same grain, same cut. In a
  barrel of a hundred, that will show. The cheap way out is to add a random per-instance
  offset to the shader's object coordinates (the same trick Rare uses on rocks), but that
  requires the plank to stop being a single baked atlas — or two or three variants to be
  baked.
- **The texture does not tile, and it should not.** Unlike the ship's wood
  (`ProceduralTextures.ts`), the UV here is a single-piece atlas.
- **The 45 mm thickness is the most arguable number.** It is in the middle of the real hull
  planking range (38–50 mm) and it matches the ratio in the official render, but it is a
  **fat** plank: 25.6:1 of length to thickness, against 32:1 for a commercial 2×8. It was
  chosen that way on purpose — below ~35 mm, low-poly starts to look like cardboard. If the
  plank reads too heavy in the hand, this is the number that changes.
- **The `_web.glb` does not reduce the resolution**, unlike the character's (which goes from
  4K down to 2K). 1024² is already the minimum that holds the chamfer highlight; the
  378 KB → 64 KB gain comes from WebP alone.
