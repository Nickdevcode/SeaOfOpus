"""Helm: one cycle, one spoke handle, and the wheel as the ruler.

This clip follows the same rule that governs every other one in this folder —
**no clip runs on the clock if there is a physical quantity to read it from**.
The walk reads distance, the jump reads vertical speed, the climb reads the
height gained. Here the quantity is the **wheel angle**, and the match is the
cleanest in the project:

```
phase = frac(wheelAngle / (π/4))
```

One cycle of the clip covers exactly **45° of wheel**, which is the pitch of the
eight handles. Since the pitch is the same anywhere along the travel, getting
the phase right gets it right forever: the hand lands on top of a **drawn**
handle, with the rudder amidships, hard to port or anywhere in between. There is
no alignment to do on grabbing, the way the ladder needs one
(`ClimbClock.align`) — the wheel's grid is periodic from birth.

And, as on the ladder, **turning the other way is this same clip with the phase
running backwards**. It's not thrift: the contacts of a turn to port have to
land on the same eight handles as a turn to starboard, and a second clip would
have to reproduce that grid. Running the same cycle with a decreasing phase
makes the contact identical by construction — the hand that was pulling starts
pushing, which is exactly what the helmsman does.

## Why the two hands sit 45° apart, and not wherever would be convenient

Because the handles do. Two hands on two handles are always an **integer
multiple of 45°** from each other — there is no picking 25° or 60°. That is the
first fact this file had to swallow, and it rules everything else: with the right
hand working the starboard quadrant and the left the port one, they take turns
around the top of the wheel, which is where this character's arm reaches.

## The reach deficit, which is the real subject

Projected onto the plane of the wheel, the shoulder falls **almost right on the
circle of handles**: the grip radius is 0.660 m and the shoulder sits 0.683 m
from the hub. In two dimensions the man holds the wheel effortlessly. The
problem is the third:

```
helmsman's post .......... z = 7.170        (HELM_STAND, today)
plane of the wheel ....... z = 6.320
gap to cover ............. 0.850 m
arm (shoulder→palm) ...... 0.678 m
```

**17 cm are missing**, and no pose invents them for free. This file shipped two
variants so the decision could be made by eye, and not by argument. **The
decision is made: `NEAR` won** — and it is the one carrying the name `Helm`.

- `NEAR` — **the canonical one**. The post comes 23 cm forward (`+0.85` →
  `+0.62`). Upright posture, bent elbow, arm at **88%**. It asks the game for
  the two lines listed in `NEAR.note`, and that is all it asks.
- `INTACT` — the road not taken. Nothing changed in the game: the 17 cm came out
  of a leaning torso, hips carried forward over the ankles and a protracted
  shoulder, and cost **91%** of arm extension. It works; it looks like what it
  is, a man stretched over a wheel that is too far away. It stays under the name
  `_HelmIntact`, out of the export, as a record of where one can go back to.

Both have exactly the same contact: 2.2 cm of hand wrapping the wood, 0.3 mm of
slip, and half a millimeter of drift over the 360° of travel. What changed
between them is posture, and posture is what gets judged by eye.

## The handle is 9.5 cm across; the hand is 5.8

So **the fingers do not close around it**. The right pose is not a clenched
fist, it's a hand cupped over the top: the palm rests on the back of the handle
and the fingers come down the far side as far as they get. That is why
`FINGER_CURL` here is half the ladder's — there the rung is 5.2 cm across and
fits inside a closed hand.

The hand's *roll* is what decides whether this reads as a grip or as a fist
clenched next to the wood, and it doesn't come out of the IK: one degree of
freedom is left over once the position is solved. `_aim_hand` picks that degree
by aligning the palm with the common perpendicular between the forearm and the
**handle axis** — and this is where this file could not reuse the ladder's:
there the axis is a constant (`RUNG_AXIS`, the rungs are all parallel), here it
is **radial** and changes with every handle and every frame.

And the *sign* of that roll is mirrored between the hands, because a hand is a
chiral object: with the same (fingers, palm) pair on both sides, one thumb comes
out up and the other down. That is how the right hand spent months inverted with
every contact measurement checking out — see `PALM_SIGN`.

## And the hand grabs where the wood **is**

Sounds obvious and it wasn't. The grip angles came out of the shoulder's reach
and landed 2.7° off the grid of the eight handles; `verify()` didn't see it
because it measured the hand against a handle drawn at the hand's own angle.
Today `GRAB_R` and `GRAB_L` are points on the grid, `off_grid_deg` enforces
that, and the price — 5.4° of asymmetry between the two arcs — is described in
`SPLAY_R`.

Rig conventions, as in the rest of the folder: the character faces **-Y**,
1 unit = 1 meter, ground at Z = 0, `+X` is his left. Here -Y points at the
wheel.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import bpy
from mathutils import Matrix, Vector

import anim_climb
import anim_gait

FPS = 30

#: Frames in one cycle — 45° of wheel.
#:
#: 25 is not a round number by accident: `HAND_STANCE`, `HAND_GAP` and the offset
#: between the hands are exact twenty-fifths (17, 2 and 6 frames), so the
#: instants of letting go and grabbing land **on** a keyframe. Off the grid,
#: three.js's linear interpolation would smear the release over a whole frame and
#: the hand would leave the handle early.
#:
#: The native cadence this implies (0.833 s per handle) doesn't have to match the
#: game's, and doesn't: a `WHEEL_RATE` of 2.1 rad/s covers 45° in 0.374 s. What
#: rules the phase is the wheel angle, exactly as the climb rules on the ladder.
CYCLE_FRAMES = 25


# -- the real wheel -----------------------------------------------------------

#: Measurements read from `src/ship/ShipParts.ts` (`createWheel` and
#: `buildHelmFrame`) and from `ShipDimensions.ts`. They are here as a copy
#: because Blender doesn't read TypeScript, and commented because a loose number
#: turns into a lie the first time somebody touches the ship.
#:
#: All of it converted from the **ship's** system (+Y up, -Z bow, +X starboard)
#: to the **rig's** (+Z up, -Y front, +X the character's left), with the origin
#: at the helmsman's feet:
#:
#:     rig_x = -ship_x        rig_y = ship_z - 7.170        rig_z = ship_y - 1.825
#:
#: The mirror in X is not a detail: facing the bow, port is on the helmsman's
#: left, and it is his left hand that works the port side of the wheel.
WHEEL_Y = 2.620                       # hub height on the ship
DECK_Y = 1.740 + 0.085                # QUARTERDECK_Y + deckCamber(0, ...) = 1.825
#: Hub height above the feet. It is the vertical anchor for everything here.
HUB_Z = WHEEL_Y - DECK_Y              # 0.795

WHEEL_RADIUS = 0.550                  # mean radius of the rim
RIM_TUBE = 0.055                      # half thickness of the rim
#: The handle is a **radial** tube, in the plane of the wheel — as on a real
#: helm, it is the spoke that goes through the rim and sticks out the far side.
#: It runs from `R + 0.03` to `R + 0.19`, tapering from 5.2 to 4.3 cm of radius.
HANDLE_INNER = WHEEL_RADIUS + 0.030   # 0.580
HANDLE_OUTER = WHEEL_RADIUS + 0.190   # 0.740
HANDLE_RADIUS = 0.0475                # mean of the taper
#: Where the hand grabs: the middle of the handle.
GRIP_RADIUS = 0.5 * (HANDLE_INNER + HANDLE_OUTER)     # 0.660

HANDLE_COUNT = 8
HANDLE_PITCH = 360.0 / HANDLE_COUNT   # 45°
#: Handle zero is born at the top, and it is the one carrying the brass mark for
#: the rudder amidships. World angle of handle *i*:
#: `HANDLE_ZERO + i·45° - wheelAngle`.
HANDLE_ZERO = 90.0

HUB_RADIUS = 0.135
HUB_HALF = 0.110

#: Parts of the frame that close off the grip window. None of them is decoration:
#: they are what forbids the hand from going down onto the lower handles.
CROSSBAR_Z = HUB_Z - 0.520            # crossbar at chest height
CROSSBAR_HALF = (1.035, 0.080, 0.070)  # half measures in rig (x, y, z)
DRUM_RADIUS = 0.220                   # rudder drum, a cylinder along X
DRUM_HALF_X = 0.220
#: Iron bearing tying the post to the axle — a bar along X at exactly hub
#: height. It is this, not the drum, that cuts off the 3 and 9 o'clock handles.
BEARING_RADIUS = 0.055
BEARING_INNER_X = 0.300
BEARING_OUTER_X = 0.890
POST_X = 0.950
POST_HALF = (0.085, 0.105)            # half width in x, half thickness in y
POST_TOP_Z = (WHEEL_Y + 0.26) - DECK_Y


# -- grip geometry ------------------------------------------------------------

#: Shoulder at rest, read from the rig (`upperarm.L.head_local`). It lives here
#: as a constant because the hands' working angle comes out of it, and that
#: calculation has to happen the moment the module is read — before any scene.
SHOULDER_X = 0.145
SHOULDER_Z = 1.462
#: Arm lengths, also from the rig. `build` re-reads everything from the armature
#: and uses that; these are only for the reach arithmetic that documents the
#: deficit.
HUMERUS = 0.3576
FOREARM = 0.2503

#: Distance from the wrist (the joint) to the center of the handle (the piece of
#: wood), along the forearm. Same definition as in `anim_climb`: what holds on is
#: the **palm**, and aiming the joint instead throws 7 cm of reach away.
HAND_GRIP_REACH = anim_climb.HAND_GRIP_REACH   # 0.070

#: Total shoulder→palm reach. It is the ruler the deficit is measured against.
ARM_REACH = HUMERUS + FOREARM + HAND_GRIP_REACH  # 0.678

#: **Where the arm reaches best**, and not where it would look pretty.
#:
#: Projected onto the plane of the wheel, the shoulder is `hypot(0.145;
#: 1.462-0.795)` = 0.683 m from the hub, against 0.660 m for the grip circle:
#: practically right on top of it. So the easiest handle to reach is the one at
#: the **same azimuth** as the shoulder, and every degree away from that azimuth
#: costs reach squared.
#:
#: For the right hand that gives 77.7° (measured from the ship's +X axis,
#: counterclockwise); for the left, its mirror, 102.3°. Both sit **around the top
#: of the wheel**, and not at 10 and 2 the way the helmsman photo demands: at 2
#: o'clock the handle is 0.93 m from the shoulder, and the arm has 0.678.
#:
#: It is the **optimal** azimuth, not the grip one: what rules the grip angle is
#: the grid of the eight handles (see `GRAB_R`). Here it serves as the reference
#: for measuring how far each hand ended up from the ideal — `SPLAY_R` and
#: `SPLAY_L`.
REACH_ANGLE = math.degrees(math.atan2(SHOULDER_Z - HUB_Z, SHOULDER_X))

#: Fraction of the cycle each hand spends locked onto a handle.
#:
#: It decides two things at once, and they pull in opposite directions. A hand's
#: **excursion** is `HAND_STANCE × 45°` — the longer it stays locked, the farther
#: from the optimal azimuth it travels, and the more the arm stretches. But it is
#: also what buys the time with **both** hands on the wheel, which is what makes
#: the helmsman look like a helmsman and not a juggler.
#:
#: 0.68 puts 44% of the cycle with both hands locked and takes the excursion to
#: 30.6° — 20.2° off the optimal azimuth in the worst frame, which the arm takes.
HAND_STANCE = 0.68

#: Fraction of the cycle with **no** hand on the wheel.
#:
#: Looks like a defect and is the opposite: without it the two hands fight over
#: the same handle. The arithmetic is unavoidable. With the hands always a
#: multiple of 45° from each other, and each having to let go and re-grab once
#: per cycle, either a gap with no hand at all is left over or an instant with
#: both in the same place is — and the second one is interpenetration on screen.
#:
#: The size of the gap is what separates the two arcs: they end up `45° ×
#: HAND_GAP` apart. At 0.08 the measurement found **6 cm** between the palms in
#: the worst frame of the handover, against a hand 9 cm wide — the two went
#: through each other. At 0.12 it is 12 cm, and the handover goes clean. The
#: price is three frames in twenty-five with no hand on the wheel, and less than
#: half a degree of reach.
HAND_GAP = 0.12

#: Excursion of one hand, in degrees of wheel.
SWING = HAND_STANCE * HANDLE_PITCH                    # 30.6°
#: Separation between the centers of the two arcs, in the world. It comes out of
#: the arithmetic above, not out of choice: `45° × (stance + gap)`. It is the same
#: as `CENTER_L − CENTER_R` further down, and checking the two against each other
#: is the test that the grid closed.
CENTER_SPREAD = (HAND_STANCE + HAND_GAP) * HANDLE_PITCH   # 36.0°

#: Phase at which each hand grabs. The right one opens the cycle; the left comes
#: after, by however much the gap and the stance leave.
GRAB_PHASE_R = 0.0
GRAB_PHASE_L = 1.0 - HAND_STANCE - HAND_GAP           # 0.20

#: Angle at which each hand **takes** the handle: the top of its arc. Turning the
#: wheel to starboard the handles come down, so the hand grabs high and rides down
#: with it.
#:
#: > [!warning] These two numbers are **not a choice**: they are the wheel's grid
#: > Phase zero of the clip is `wheelAngle ≡ 0 (mod 45°)`, because that is what
#: > `HelmClock` computes. At that instant the eight handles are exactly at
#: > `HANDLE_ZERO + i × 45°` — the brass handle at the top, which is the rudder
#: > amidships mark the player uses to orient himself. So, for the hand to land
#: > on **drawn** wood, the grip angle has to be a point on that grid, and not
#: > whatever the shoulder's reach would prefer.
#: >
#: > This file picked reach for three months. Both hands grabbed 2.7° off the
#: > grid — 3.1 cm of arc —, and nobody saw it because `verify()` measured the
#: > hand against a handle drawn **at the hand's angle**, and not against the
#: > eight that exist: a phantom handle follows any position error. What actually
#: > happened was the palm sinking 2 cm into the wood, hidden by how much the cup
#: > of the hand already overlaps the piece on purpose.
#: >
#: > The error only showed up the day the right hand's palm moved to the other
#: > side of the handle (see `PALM_SIGN`): there the 2.7° stopped being
#: > compensated by the palm's offset and turned into 1 cm of hand in mid-air,
#: > which `sweep_check` called out on the spot.
#:
#: The left hand takes the next handle, and the `1 − GRAB_PHASE_L` is how much the
#: wheel has already turned by the time its turn comes: between the two grabs the
#: world moved, and that is why the two angles end up 36° apart in the world while
#: the **handles** stay 45° apart on the wheel, as they always were.
GRAB_R = HANDLE_ZERO
GRAB_L = HANDLE_ZERO + HANDLE_PITCH * (1.0 - GRAB_PHASE_L)

#: Center of each hand's arc, in world wheel angle.
CENTER_R = GRAB_R - 0.5 * SWING
CENTER_L = GRAB_L - 0.5 * SWING

#: How far each arc ended up from its shoulder's optimal azimuth. **Not a choice,
#: it's the remainder**: the grid and the grab phases already decided everything,
#: and this is the tally of the damage.
#:
#: Splitting the deviation equally between the two hands is what the previous
#: version did, and it was prettier on paper — 5.7° to each side. It cost both
#: hands off the grid, which is the defect described above. This way the right one
#: sits 3.0° from optimal and the left 8.4°, and the asymmetry is unavoidable as
#: long as there is a gap: with `HAND_GAP` at zero the two arcs would be
#: symmetric, and the two hands would fight over the same handle at the handover.
#:
#: The price is 1.2 cm of reach on the left arm, and it fits: the worst frame sits
#: at 85% of extension, against the 98% stop.
SPLAY_R = REACH_ANGLE - CENTER_R
SPLAY_L = CENTER_L - (180.0 - REACH_ANGLE)


# -- how the hand lands on the handle -----------------------------------------

#: How far the grip point sits from the handle's **axis**.
#:
#: The handle is 9.5 cm across and the hand doesn't close around it: it rests on
#: top. So the grip point doesn't go on the axis of the wood — it goes outside it,
#: plus half a palm's thickness. Nailing the point to the axis drives the handle
#: through the middle of the hand, which is the same mistake `anim_climb` already
#: paid for with the rung.
#:
#: The centimeter of slack over the radius is **measured**, not chosen, and was
#: tuned twice: at 0.8 cm `verify()` found the palm 1.9 cm inside the wood and the
#: middle fingertip 3.2 cm — past the center of the piece; at 2.4 cm the palm sat
#: 1.2 cm **outside**, floating, and only the fingers touched. Every centimeter
#: here comes one for one out of the penetration.
PALM_OVER_HANDLE = HANDLE_RADIUS + 0.010

#: How far the hand pulls away from the plane of the wheel halfway through the
#: return trip, toward the helmsman.
#:
#: Not an ornament: between letting go of one handle and taking the next the hand
#: crosses **one** whole handle (it moves 45° relative to the wheel, which is the
#: pitch). Without pulling back, it goes through the wood. 12 cm is what clears
#: the piece plus the hand itself.
HAND_LIFT = 0.120
#: And it shrinks the radius a little on the way back, so the forearm doesn't open
#: out against the post that sits at x = ±0.95.
HAND_SWING_NARROW = 0.045

#: Finger closure on the wood, in degrees per phalanx.
#:
#: Much less than on the ladder (42/48), and the reason is arithmetic: a 4.6 cm
#: finger wraps `4.6/2.6 = 1.8 rad` of a ladder rung and only `4.6/4.75 =
#: 0.97 rad` of this handle. Half the arc, half the bend. Bending all the way puts
#: the phalanx inside the wood and the hand reads as a punch.
FINGER_CURL = (28.0, 32.0)
THUMB_CURL = (17.0, 20.0)
FINGERS = anim_climb.FINGERS

#: Extension ceiling for the limbs, the same as in the rest of the folder.
ARM_EXTENSION_LIMIT = anim_climb.ARM_EXTENSION_LIMIT      # 0.980
LEG_EXTENSION_LIMIT = anim_climb.LEG_EXTENSION_LIMIT      # 0.985

#: Where the elbow points. Out and **down**, as in the climb, and for the same
#: reason: with the hint thrown backwards the arm turns into a chicken wing on
#: every frame. Here there is an aggravating factor — the arm works almost
#: straight forward, and that is exactly where the IK is freest to choose wrong.
ELBOW_HINT = (0.62, 0.20, -0.76)
#: Knee forward, and a hand's width out: it's the stance of a man braced.
KNEE_HINT = (0.22, -0.97, 0.0)


# -- the two variants ---------------------------------------------------------


@dataclass(frozen=True)
class Stand:
    """A helmsman's post: where he stands and how he stretches to reach the wheel.

    The two instances below exist to be **compared by eye**. They don't differ in
    style: they differ in how much of the 17 cm deficit each one pays with
    posture, and posture has a price on screen.
    """

    name: str
    action: str
    #: Distance from the feet to the plane of the wheel, in meters.
    #: `HELM_STAND.z - 6.320`.
    stand: float

    # -- what the body does to reach ------------------------------------------
    #: How far the hips carry forward over the ankles, with the feet planted.
    surge: float
    #: How far the body settles. Negative bends the knees — and it **has** to be
    #: negative when there is surge: this rig's leg is already at 99% extension
    #: standing, so every centimeter forward without sinking the hips blows up the
    #: IK.
    settle: float
    #: Torso lean, in degrees. Positive throws the chest at the wheel.
    lean: float
    #: Shoulder projection (clavicle protraction), in degrees. It is the baseline;
    #: whoever needs more gets more, through `SHOULDER_REACH_GAIN`.
    shoulder: float

    # -- where the feet go ----------------------------------------------------
    #: Half the distance between the ankles.
    foot_x: float
    #: How far the left foot advances and the right one falls back. Staggered
    #: stance: it is what holds up the lean without the character falling forward.
    foot_stagger: float
    #: Toe-out of the feet, in degrees.
    foot_splay: float

    note: str = ""


#: **Variante A — geometria intacta.** *Preterida.* Referência histórica.
#:
#: Era a variante que não cobrava nada do jogo, e foi por isso que existiu. Perdeu
#: para a B na única prova que este arquivo deixa em aberto — o olho —, e sai daqui
#: sob o nome `_HelmIntact`: o underscore é o mesmo contrato do `_ClimbPreview`, e
#: `export.py` varre toda action que comece com ele. Ou seja, ela **não vai** para
#: o FBX nem para o GLB — e o `export_all` chega a apagá-la do `.blend` que grava,
#: exatamente como faz com o `_ClimbPreview`. Isso não é perda: como todo o resto
#: desta pasta, ela é dado derivado, e `build(INTACT)` a reconstrói igual — é o
#: que se roda depois de exportar para o arquivo de trabalho voltar a ter as duas
#: lado a lado. E é assim que se volta atrás, se aproximar o posto se mostrar
#: ruim dentro do jogo.
#:
#: Os 17 cm saem de três lugares, e nenhum é grátis: 15 cm de quadril avançado
#: sobre os tornozelos (o que obriga a afundar 7 cm, senão a perna estoura), 18°
#: de tronco e 12° de clavícula. O resultado é honesto e é o ponto: o personagem
#: **fica** com cara de quem se estica para alcançar, porque é o que a geometria
#: de hoje pede dele — e a medição fecha em 91% de extensão de braço, contra os
#: 88% que o posto aproximado consegue com o tronco quase reto.
#: O assentamento de 7 cm e a base de 9 cm não são gosto: são o que a perna
#: deixou. Com 5 cm de assentamento e 13 cm de base a medição achou o pé direito
#: **11,3 mm fora do alvo**, com a IK batendo no batente de 98,5% — o quadril
#: tinha avançado 15 cm enquanto o tornozelo de trás ficava 13 cm para trás, e
#: 28 cm de vão horizontal não cabem numa perna de 78,8 cm que já está quase
#: reta de pé. Afundar o quadril devolve o alcance, e de quebra é o que uma
#: pessoa firmada contra uma roda faz com os joelhos.
INTACT = Stand(
    name="intact",
    action="_HelmIntact",
    stand=0.850,
    surge=0.150,
    settle=-0.070,
    lean=18.0,
    shoulder=12.0,
    foot_x=0.185,
    foot_stagger=0.090,
    foot_splay=13.0,
    note="nada muda no jogo",
)

#: **Variante B — timoneiro aproximado. Aprovada, e por isso a dona do nome
#: `Helm`.** `HELM_STAND` vem de +0,85 para +0,62.
#:
#: 0,62 não é arredondamento: é o maior valor que ainda deixa o pior quadro do
#: braço abaixo de 88% de extensão, e está confortavelmente acima do menor que
#: cabe. Abaixo dele o cilindro de colisão do jogador (0,30 m) começa a encostar
#: no tambor do leme, cuja face de ré fica a 0,22 m do plano da roda — em 0,62
#: sobram 10 cm. O tronco fica a 11,7 cm da madeira mais próxima, medido na
#: malha deformada por `clearance()`.
#:
#: Com o posto mais perto, o corpo pode ficar **em pé**: 4 cm de avanço, 7° de
#: tronco e 5° de clavícula, que é a postura de quem está com as mãos apoiadas em
#: alguma coisa, não a de quem se estica para alcançá-la.
#:
#: A action nasceu como `_HelmNear` para **não** poder ser exportada enquanto o
#: jogo não mudasse: ela agarra punhos que estão 23 cm além de onde o personagem
#: estava, e o `export.py` varre toda action que comece com underscore. Aprovada,
#: perdeu o underscore — o que também quer dizer que **o jogo deixou de ser
#: opcional**. Sem as duas linhas de `note` aplicadas, o timoneiro fica com as
#: mãos 23 cm à frente da roda e o cilindro de colisão o expulsa do posto.
#: Reverter é trocar `action` de volta com a A: o nome manda em tudo o mais.
NEAR = Stand(
    name="near",
    action="Helm",
    stand=0.620,
    surge=0.040,
    settle=-0.045,
    lean=7.0,
    shoulder=5.0,
    foot_x=0.180,
    foot_stagger=0.055,
    foot_splay=10.0,
    note=("ShipBuilder.ts:40 `tToZ(STATIONS.helm) + 0.85` -> `+ 0.62`; "
          "PlayerController.ts:372 raio do blocker do timão 0.5 -> 0.32 "
          "(= 0.62 - PLAYER_RADIUS), senão o jogador é expelido do posto"),
)

VARIANTS = {"intact": INTACT, "near": NEAR}

#: Quanto de protração extra a clavícula ganha quando o braço está no limite.
#:
#: A alternativa era um número fixo, e ela desperdiça: o ombro só precisa avançar
#: no quadro em que a mão está longe, e avançar sempre deixa o personagem de
#: ombros encolhidos o ciclo inteiro. Ligado à demanda, o ritmo escápulo-umeral
#: aparece sozinho — o ombro da mão que está esticada vai junto com ela.
SHOULDER_REACH_GAIN = 9.0
#: Demanda (fração do alcance) a partir da qual o ombro começa a ajudar.
SHOULDER_REACH_ONSET = 0.80

#: Balanço lateral do corpo para o lado das mãos, em metros por raio de pega.
#:
#: Subiu de 0,022 para 0,045 quando a âncora deixou de ser a média dos punhos
#: **presos** e passou a ser a média ponderada pela carga: a de antes saltava de
#: uma mão para a outra e cobria 231 mm de excursão em degraus, a de agora anda
#: 120 mm de forma contínua. Sem o ajuste, arrumar o tranco teria custado metade
#: do balanço que já existia.
BODY_SWAY = 0.045
#: Torção do tronco atrás das mãos. Pouco: os dois punhos estão perto do topo da
#: roda e a diferença lateral entre eles nunca passa de meio palmo.
TORSO_TWIST = 6.0
#: Queda e torção do quadril, no ritmo do apoio.
PELVIS_ROLL = 2.5
PELVIS_YAW = 3.5
#: Levantada do ombro da mão que está no alto do arco.
SHOULDER_RISE = 5.0

#: Quanto o corpo sobe e desce ao longo do ciclo, em metros de amplitude.
#:
#: O clipe não tinha componente vertical **nenhuma**, e é ela que faltava para o
#: gesto ter peso: um homem que empurra uma roda presa a um leme de 35° assenta
#: nos joelhos enquanto empurra o punho para baixo e volta a subir quando troca
#: de punho. Sai do `drive` — a altura das mãos que estão carregando —, não de um
#: relógio: mesmo contrato do resto da pasta.
#:
#: A perna paga, e o número é medido: 2 cm levam o pior quadro de 95,0% para
#: **97,2%** de extensão, ainda sob o batente de 98,5% da IK, com o pé cravado
#: no alvo (`foot_error_mm` continua em 0,002). Acima disso a perna trava e o
#: quadril para de subir sem que nada avise — o `build` mediria a mesma pose e
#: só o olho veria o corpo achatar no alto do ciclo.
BODY_PULSE = 0.020
#: E quanto ele entra na roda no mesmo compasso, em metros. Ombro mais perto do
#: punho é alcance de graça exatamente no quadro em que o braço mais precisa.
BODY_SURGE = 0.015
#: Quanto o tronco fecha sobre a roda no mesmo compasso, em graus. Some com a
#: inclinação de base da variante, e a cabeça desfaz os dois juntos —
#: `_pose_torso` lê `plan["lean"]`, e não `variant.lean`, justamente para o olhar
#: não subir e descer junto com o corpo.
LEAN_PULSE = 2.5
#: Para onde o timoneiro olha: a proa, um palmo abaixo do horizonte — o mesmo
#: `pitch = -0.14` que o `takeHelm` escreve na câmera. Positivo é para baixo.
HEAD_PITCH = 8.0
#: Quanto o pescoço e a cabeça desfazem a inclinação do tronco. Sem isto o
#: personagem governa olhando para os próprios pés — e na variante A, que
#: inclina 18°, o defeito é gritante.
HEAD_COUNTER = 1.10


# -- onde cada mão está, na fase t --------------------------------------------

#: Quanto o corpo antecipa a pega e sobrevive à soltura, em fração de ciclo.
#:
#: Sem isto a carga nasce e morre exatamente nos instantes em que a mão toca e
#: larga a madeira, e nos 12% de ciclo em que nenhuma das duas está na roda o
#: corpo fica **parado no zero** — três quadros de estátua no meio do gesto. É a
#: mesma ideia que `Hand.closure` já usa nos dedos: a mão se prepara, não reage.
#: 0,06 são um quadro e meio de cada lado, o bastante para as duas cargas se
#: cruzarem dentro do vão.
LOAD_LEAD = 0.06

#: Quanto do braço o tronco sente com a mão **fora** da roda.
#:
#: Zero seria dizer que um braço no ar não existe, e nos 12% do ciclo em que
#: nenhuma mão segura a média ponderada não teria denominador. O braço continua
#: pesando 3 kg pendurados num ombro, então o piso é o que sobra da influência
#: quando a carga vai a zero.
ARM_INFLUENCE = 0.25


@dataclass(frozen=True)
class Hand:
    """Uma mão ao longo do ciclo: quando pega, quanto segura, por onde volta.

    Presa, ela **não escolhe nada**: vai onde o punho for, e o punho vai onde a
    roda mandar. É essa submissão que faz o contato não escorregar, e é o mesmo
    contrato que a mão da escada assina com o degrau — só que lá a peça desce
    numa reta e aqui ela desce num arco.
    """

    side: str
    #: Fase em que toma o punho, em [0, 1).
    grab: float
    #: Ângulo mundial do punho no instante em que ela o toma, em graus.
    angle: float

    def hold(self, t: float) -> float | None:
        """Quanto do apoio já correu na fase *t*, ou `None` se está viajando."""
        k = (t - self.grab) % 1.0
        return k if k <= HAND_STANCE else None

    def load(self, t: float) -> float:
        """Quanto do **peso** esta mão sustenta na fase *t*, em [0, 1].

        Não é o mesmo que `hold`, e a diferença é o assunto inteiro da suavidade
        deste clipe. `hold` é binário: a mão está na madeira ou não está. Se o
        corpo for lido dele — e era —, tudo o que o corpo faz muda de valor de um
        quadro para o outro, quatro vezes por ciclo. Numa action interpolada
        linearmente isso é um tranco de 1/25 de segundo, e é exatamente o que se
        via: o quadril dava um tapa de lado a cada troca de punho.

        O peso não migra assim. Uma mão que acabou de pousar ainda não carrega
        nada, e uma que está prestes a soltar já entregou o que tinha à outra —
        que é a razão de o apoio duplo ocupar 48% do ciclo. Aqui a transferência
        é uma rampa de derivada nula nas duas pontas (`smoothstep`), então não é
        só a posição do corpo que fica contínua: a **velocidade** também, que é o
        que separa movimento de tique.

        A forma não tem número escolhido: é um corcovado que **vale 1 no meio do
        trecho em que esta mão é a única na roda** e cai a zero nas duas pontas
        do apoio. Quando as duas seguram o peso se reparte, quando uma solta a
        outra assume tudo — dizer isso já descreve a curva inteira, e ela se
        refaz sozinha se `HAND_STANCE` ou `HAND_GAP` mudarem.

        Daí sai de graça a assimetria que o gesto tem de verdade: a direita fica
        sozinha logo **depois** de pegar e a esquerda logo **antes** de largar
        (é onde o vão cai), então uma carrega cedo e descarrega devagar, e a
        outra faz o contrário. Escrever isso à mão seria escolher; lido do vão, é
        consequência.
        """
        k = (t - self.grab) % 1.0
        if k > HAND_STANCE + LOAD_LEAD:
            k -= 1.0                     # ainda antes de pegar: fase negativa
        if k < -LOAD_LEAD:
            return 0.0
        peak = LOAD_PEAK[self.side]
        rise = anim_gait.smoothstep(anim_gait.ramp(k, -LOAD_LEAD, peak))
        fall = anim_gait.smoothstep(anim_gait.ramp(k, peak, HAND_STANCE + LOAD_LEAD))
        return rise * (1.0 - fall)

    def handle_angle(self, t: float) -> float:
        """Ângulo mundial do punho que ela segura (ou vai segurar) na fase *t*.

        Fora do apoio devolve o ângulo do ponto da viagem — que não é punho
        nenhum, mas é a mesma coordenada e mantém o resto do arquivo em um
        sistema só.
        """
        k = (t - self.grab) % 1.0
        if k <= HAND_STANCE:
            return self.angle - HANDLE_PITCH * k

        # Viagem. Sai de onde o apoio terminou e chega exatamente no ângulo de
        # onde partiu — onde, por construção, haverá **outro** punho esperando:
        # um ciclo é um passo de punho, então o próximo já está chegando ali.
        s = (k - HAND_STANCE) / (1.0 - HAND_STANCE)
        low = self.angle - SWING
        # Largar a madeira não para a mão: ela sai com a velocidade que o punho
        # lhe deu, e só depois inverte. Tangente de partida negativa faz isso.
        return low + SWING * anim_gait.hermite(s, -0.40, 0.0)

    def travel(self, t: float) -> float:
        """Progresso da viagem em [0, 1]; zero enquanto está presa."""
        k = (t - self.grab) % 1.0
        if k <= HAND_STANCE:
            return 0.0
        return (k - HAND_STANCE) / (1.0 - HAND_STANCE)

    def closure(self, t: float) -> float:
        """Quanto a mão está fechada na fase *t*.

        Fecha **antes** de tocar a madeira e abre logo depois de soltar: a mão se
        prepara, não reage. Uma mão cerrada atravessando o vão entre dois punhos é
        o que mais denuncia animação feita às pressas.
        """
        k = (t - self.grab) % 1.0
        if k <= HAND_STANCE:
            # Afrouxa nos últimos 8% do apoio, quando já está saindo.
            return 1.0 - 0.55 * anim_gait.smoothstep(
                anim_gait.ramp(k, HAND_STANCE - 0.08, HAND_STANCE))
        s = self.travel(t)
        if s < 0.5:
            return 0.45 * (1.0 - anim_gait.smoothstep(anim_gait.ramp(s, 0.0, 0.40)))
        return anim_gait.smoothstep(anim_gait.ramp(s, 0.55, 1.0))


HANDS = {
    "R": Hand(side="R", grab=GRAB_PHASE_R, angle=GRAB_R),
    "L": Hand(side="L", grab=GRAB_PHASE_L, angle=GRAB_L),
}

def _alone_window(hand: Hand) -> tuple[float, float]:
    """Trecho do apoio de *hand*, em fase local, em que a outra mão está fora.

    O `+ 0,5` antes do módulo não é enfeite: sem ele, a mão que pegou **antes**
    aparece como se pegasse 0,80 depois, e o trecho sozinho sairia no lugar
    errado — a esquerda ficaria com o perfil da direita.
    """
    other = HANDS["L" if hand.side == "R" else "R"]
    start = ((other.grab - hand.grab + 0.5) % 1.0) - 0.5
    if start >= 0.0:
        return (0.0, start)                        # a outra chega depois
    return (start + HAND_STANCE, HAND_STANCE)      # a outra sai antes


#: Fase, dentro do apoio, em que cada mão carrega o máximo: o meio do trecho em
#: que ela é a única na roda. Ver `Hand.load`.
LOAD_PEAK = {side: 0.5 * sum(_alone_window(hand))
             for side, hand in HANDS.items()}


# -- do ângulo da roda para o espaço do rig -----------------------------------


def handle_point(variant: Stand, angle: float, radius: float = GRIP_RADIUS) -> Vector:
    """Um ponto do punho de ângulo mundial *angle*, no espaço do rig.

    O sinal negativo em X é a conversão de bordo: o navio mede boreste em +X e o
    rig mede a **esquerda do personagem** em +X, e o timoneiro olha para a proa.
    Trocar esse sinal põe a mão direita em cima dos punhos de bombordo e o
    resultado não denuncia sozinho — as duas mãos continuam na roda, só que
    cruzadas.
    """
    rad = math.radians(angle)
    return Vector((-radius * math.cos(rad),
                   -variant.stand,
                   HUB_Z + radius * math.sin(rad)))


def handle_axis(angle: float) -> Vector:
    """Direção do eixo do punho de ângulo *angle*, do cubo para fora."""
    rad = math.radians(angle)
    return Vector((-math.cos(rad), 0.0, math.sin(rad)))


#: De que lado do punho cada mão pousa, em torno do eixo da peça.
#:
#: `+1` é a tangente **descendente** da roda; `-1`, a ascendente. Ver
#: `palm_direction` para o porquê de os dois sinais serem obrigatórios.
PALM_SIGN = {"L": 1.0, "R": -1.0}


def palm_direction(side: str, angle: float) -> Vector:
    """Para onde a palma olha ao pousar no punho de ângulo *angle*.

    A palma é perpendicular ao eixo da peça — é a superfície que encosta na
    madeira, e os dedos, que são filhos dela, fecham nessa direção. Isso fixa o
    **plano**; sobram dois sentidos, e escolher entre eles é a decisão mais
    delicada deste arquivo: errado, o punho sai pelo dorso da mão e todas as
    métricas de **posição** continuam dando zero, porque medir onde a palma está
    não diz nada sobre para onde ela aponta.

    > [!warning] E o sentido **não pode ser o mesmo para as duas mãos**
    > Foi assim que este arquivo nasceu — a tangente descendente para ambas — e o
    > defeito ficou meses no jogo: a mão direita saía de cabeça para baixo. A
    > causa é que uma mão não é um plano, é um objeto **quiral**. Fixados a
    > direção dos dedos e a normal da palma, o polegar não é mais escolha: ele
    > cai em `dedos × palma` de um lado e em `-(dedos × palma)` do outro. Com os
    > dois valores iguais nas duas mãos, um polegar aponta para cima e o outro
    > para baixo — e nenhuma medida de contato reclama, porque a palma continua
    > encostando na madeira do jeito certo.
    >
    > Medido no clipe antigo, com as duas mãos presas: `polegar · eixo do punho`
    > dava **+0,67 na esquerda e −0,67 na direita**. É a assinatura exata do
    > erro, e é o que `verify()` passou a cobrar (`thumb_along_spoke_min`).

    Com o sinal espelhado, cada mão pousa **do seu próprio lado** do punho e
    olha para o meio do corpo — que é o que um par de mãos faz ao segurar duas
    barras verticais à frente do peito, e o que se vê em qualquer foto de
    timoneiro: os dois polegares para cima, subindo o raio.

    As duas alternativas testadas antes continuam caindo, e por isto o sentido
    sai da tangente e não de outra régua:

    - *palma sempre para baixo* empata no punho do topo, onde a peça aponta para
      o céu e não existe "para baixo" perpendicular a ela;
    - *palma para o lado oposto ao ombro* é **descontínua**: o azimute do ombro
      cai dentro do arco da mão direita, e ao cruzá-lo o pulso daria um giro de
      180° em dois quadros.

    A tangente não empata nunca, e o sinal por mão é constante ao longo de todo
    o arco — os dois arcos ficam de lados opostos do topo da roda e nunca se
    cruzam, então não há onde a escolha virar salto.
    """
    rad = math.radians(angle)
    sign = PALM_SIGN[side]
    return Vector((-sign * math.sin(rad), 0.0, -sign * math.cos(rad)))


def grip_target(variant: Stand, hand: Hand, t: float) -> Vector:
    """Onde a **palma** tem de estar na fase *t*.

    Presa, é o dorso do punho: o eixo da madeira deslocado de
    `PALM_OVER_HANDLE` no sentido contrário ao que a palma olha — o que, com o
    sinal espelhado de `palm_direction`, põe cada mão do **seu** lado da peça, a
    de fora do centro do corpo. Viajando, é o mesmo ponto puxado para o
    timoneiro e encolhido em raio, para a mão passar por **cima** do punho que
    ela cruza no caminho em vez de por dentro dele.
    """
    angle = hand.handle_angle(t)
    arc = math.sin(math.pi * hand.travel(t))

    radius = GRIP_RADIUS - HAND_SWING_NARROW * arc
    target = handle_point(variant, angle, radius)
    target -= palm_direction(hand.side, angle) * PALM_OVER_HANDLE
    target.y += HAND_LIFT * arc          # +Y é para trás, na direção do timoneiro
    return target


# -- postura ------------------------------------------------------------------


def _anchor(variant: Stand, t: float) -> tuple[Vector, float]:
    """Onde estão as mãos, ponderadas pelo peso que cada uma sustenta.

    Devolve o ponto e o ``bias``: para que lado o peso está, de −1 (tudo na
    direita) a +1 (tudo na esquerda).
    """
    point = Vector((0.0, 0.0, 0.0))
    influence = 0.0
    bias = 0.0
    for side, hand in HANDS.items():
        load = hand.load(t)
        # O braço no ar não sustenta nada, mas continua pendurado no ombro: daí
        # o piso, que é também o que garante denominador nos 12% do ciclo em que
        # nenhuma das duas está na madeira.
        share = ARM_INFLUENCE + (1.0 - ARM_INFLUENCE) * load
        point += grip_target(variant, hand, t) * share
        influence += share
        bias += (1.0 if side == "L" else -1.0) * load
    return point / influence, bias


#: Altura média da âncora ao longo do ciclo, e metade da sua excursão.
#:
#: Medidas, e não escritas à mão. É delas que sai o `drive` — a grandeza que
#: manda no que o clipe não tinha, o corpo subindo e descendo com o gesto — e um
#: número fixo aqui viraria um viés silencioso de postura na primeira vez que
#: alguém mexesse na pega, no vão ou na carga. A altura da âncora não depende da
#: variante (`Stand.stand` mexe em Y, não em Z), então uma medida serve às duas.
_ANCHOR_Z = [_anchor(NEAR, f / CYCLE_FRAMES)[0].z for f in range(CYCLE_FRAMES)]
ANCHOR_Z_MEAN = sum(_ANCHOR_Z) / CYCLE_FRAMES
ANCHOR_Z_HALF = 0.5 * (max(_ANCHOR_Z) - min(_ANCHOR_Z))


def body_plan(variant: Stand, t: float) -> dict:
    """Como o corpo acompanha as duas mãos, na fase *t*.

    Nada aqui é senoide inventada: as oscilações saem da **posição das mãos e da
    carga que cada uma sustenta**, que é a quem o corpo responde. Quando uma
    delas entrega o peso, o corpo migra para a outra — e isso acontece na fase
    certa de graça, porque é lido do gesto e não de um relógio paralelo.

    Duas grandezas saem daqui, e elas são independentes:

    - ``bias`` — **para onde** o peso está, de −1 (tudo na direita) a +1 (tudo na
      esquerda). Manda no balanço lateral, na torção e no quadril;
    - ``drive`` — **onde o gesto está**, de +1 (mãos no alto, começo do
      empurrão) a −1 (mãos no fundo, fim dele). Sai da altura da âncora, e manda
      no que o clipe não tinha: o corpo assenta e fecha sobre a roda enquanto
      empurra para baixo, e volta a subir na troca de punho.

    As duas são contínuas e com derivada contínua, porque `Hand.load` é. Era
    esse o defeito: lidas do `hold`, que é binário, elas davam quatro degraus por
    ciclo — o corpo andava aos trancos entre poses paradas em vez de se mover.
    """
    anchor, bias = _anchor(variant, t)

    # Normalizado, e centrado na média medida do ciclo: sem descontá-la o
    # timoneiro passaria o ciclo inteiro fora da postura que `Stand` descreve.
    drive = (anchor.z - ANCHOR_Z_MEAN) / ANCHOR_Z_HALF
    drive = min(max(drive, -1.0), 1.0)

    return {
        "sway": anchor.x / GRIP_RADIUS * BODY_SWAY,
        "twist": bias * TORSO_TWIST,
        "shoulder_bias": bias,
        "pelvis_yaw": bias * PELVIS_YAW,
        "pelvis_roll": -bias * PELVIS_ROLL,
        # Afunda, entra na roda e fecha o tronco conforme o punho desce.
        "lift": drive * BODY_PULSE,
        "surge": variant.surge - drive * BODY_SURGE,
        "lean": variant.lean - drive * LEAN_PULSE,
        "anchor": anchor,
        "bias": bias,
        "drive": drive,
    }


def _aim_root(variant: Stand, root, plan: dict) -> None:
    """Move o corpo inteiro: avanço sobre os tornozelos, assentamento e balanço.

    O avanço é o que compra alcance mais barato de todo este arquivo — 15 cm de
    quadril valem 15 cm de ombro, contra os 10 cm que 18° de tronco entregam. O
    que ele cobra é a perna: de pé, este rig já está a 99,2% da extensão, e
    avançar sem afundar o quadril manda a IK para o batente.

    O avanço e o assentamento **não são mais constantes**: os dois ganham a
    parcela de esforço que `body_plan` calculou, e é ela que dá peso ao gesto.
    Mexer o corpo aqui é de graça para o contato — os braços são resolvidos por
    IK contra alvos que saem só da roda, então a mão fica onde estava e quem se
    reacomoda é o cotovelo. O que muda é a **extensão**, e é por isso que ela é
    medida a cada quadro em `build`.
    """
    matrix = Matrix.Translation(Vector((plan["sway"],
                                        -plan["surge"],
                                        variant.settle + plan["lift"])))
    matrix = matrix @ Matrix.Rotation(math.radians(plan["pelvis_yaw"]), 4, "Z")
    root.matrix = matrix @ root.bone.matrix_local


def _pose_torso(pose, plan: dict) -> None:
    """Coluna, pescoço e cabeça. As clavículas vêm depois, com a demanda medida.

    O sinal de ``X`` é o mesmo do resto da pasta: **positivo joga o topo do bone
    para -Y**, que é para onde o personagem olha — aqui, para a roda. Trocá-lo
    inclina o pirata para trás e afasta o ombro 20 cm da madeira, e o defeito não
    salta aos olhos: ele aparece como IK do braço estourando sem explicação.

    A inclinação vem de `plan["lean"]`, e **não** de `variant.lean`: ela respira
    com o esforço. Ler a da variante aqui e a do plano no pescoço faria o olhar
    subir e descer a cada empurrão, que é o defeito que `HEAD_COUNTER` existe
    para não deixar acontecer.
    """
    lean = plan["lean"]
    pose["pelvis"].rotation_quaternion = anim_gait.world_rotation(
        pose["pelvis"], [("Y", plan["pelvis_roll"]), ("X", lean * 0.10)])

    for name, share in (("spine_01", 0.30), ("spine_02", 0.35), ("spine_03", 0.35)):
        pose[name].rotation_quaternion = anim_gait.world_rotation(
            pose[name], [("X", lean * share),
                         ("Z", plan["twist"] * share)])

    # O pescoço desfaz a inclinação e a cabeça devolve o olhar à proa. O fator
    # 1,10 é a soma do que a coluna (1,00) e a pélvis (0,10) inclinaram: sem ele
    # o timoneiro governa olhando o convés.
    undo = -lean * HEAD_COUNTER
    pose["neck"].rotation_quaternion = anim_gait.world_rotation(
        pose["neck"], [("X", undo * 0.5 + HEAD_PITCH * 0.4)])
    pose["head"].rotation_quaternion = anim_gait.world_rotation(
        pose["head"], [("X", undo * 0.5 + HEAD_PITCH * 0.6),
                       ("Z", -plan["twist"] * 0.30)])


def _pose_clavicles(variant: Stand, pose, plan: dict, targets: dict) -> dict:
    """Projeta cada ombro pelo tanto que a **sua** mão está pedindo.

    O ritmo escápulo-umeral: braço esticado não é só braço, o ombro vai junto. É
    isso que decide se a mão chega ao punho ou fica pendurada três centímetros
    atrás dele — e é a clavícula que o `anim_gait._key_frame` **não grava**, o que
    já custou 5 cm de mão no ar com todas as métricas dando zero. Ver
    `_key_frame`, aqui embaixo.

    Devolve a demanda medida de cada lado, que entra no relatório.
    """
    demand = {}
    for side in ("L", "R"):
        sign = 1.0 if side == "L" else -1.0
        shoulder = pose[f"upperarm.{side}"].matrix.translation
        need = (targets[side] - shoulder).length / ARM_REACH
        demand[side] = need

        extra = SHOULDER_REACH_GAIN * anim_gait.smoothstep(
            anim_gait.ramp(need, SHOULDER_REACH_ONSET, 1.0))
        reach = variant.shoulder + extra
        rise = SHOULDER_RISE * plan["shoulder_bias"] * sign

        # Z negativo do lado esquerdo leva o ombro para -Y, que é a frente; do
        # lado direito o bone aponta para -X e o sinal se inverte. Daí o `sign`.
        pose[f"clavicle.{side}"].rotation_quaternion = anim_gait.world_rotation(
            pose[f"clavicle.{side}"], [("Y", -sign * rise), ("Z", -sign * reach)])
    return demand


def _pose_leg(pose, data: dict, side: str, ankle: Vector, splay: float) -> tuple:
    """Uma perna por IK contra *ankle*. Devolve (erro, extensão).

    O pé fica **plantado**: o alvo não muda ao longo do ciclo, então o
    escorregamento é zero por construção. O que a IK resolve aqui é o corpo se
    movendo por cima de um pé parado, que é o oposto da marcha.
    """
    sign = 1.0 if side == "L" else -1.0
    thigh = pose[f"thigh.{side}"]
    hip = thigh.matrix.translation.copy()

    reach = data["femur"] + data["tibia"]
    extension = (ankle - hip).length / reach

    knee = anim_gait.solve_leg(hip, ankle, data["femur"], data["tibia"],
                               LEG_EXTENSION_LIMIT,
                               Vector((sign * KNEE_HINT[0], KNEE_HINT[1], KNEE_HINT[2])))
    anim_gait.aim_bone(thigh, knee - hip, hip)
    bpy.context.view_layer.update()

    calf = pose[f"calf.{side}"]
    anim_gait.aim_bone(calf, ankle - knee, calf.matrix.translation.copy())
    bpy.context.view_layer.update()

    foot = pose[f"foot.{side}"]
    error = (foot.matrix.translation - ankle).length
    # A ponta abre para fora: pé paralelo é pose de sentido, não de quem está
    # firmado contra uma roda que puxa.
    turn = Matrix.Rotation(math.radians(sign * splay), 3, "Z")
    anim_gait.aim_bone(foot, turn @ data["foot_dir"], foot.matrix.translation.copy())
    bpy.context.view_layer.update()

    toe = pose[f"toe.{side}"]
    anim_gait.aim_bone(toe, turn @ data["toe_dir"], toe.matrix.translation.copy())
    return error, extension


def _aim_hand(pose_bone, direction: Vector, palm: Vector) -> None:
    """Aponta a mão **e escolhe o giro em torno do próprio eixo**.

    É o `anim_climb._aim_hand` com o eixo da peça saindo de fora em vez de ser a
    constante `RUNG_AXIS`. A diferença não é cosmética: os degraus de uma escada
    são todos paralelos, e os punhos de uma roda são **radiais** — o eixo muda a
    cada punho e a cada quadro, e um eixo fixo aqui gira a mão para o lado errado
    em metade do ciclo, com a madeira saindo pelo meio dos dedos e todas as
    métricas de posição continuando a dar zero.
    """
    rest = pose_bone.bone.matrix_local
    rest_dir = (pose_bone.bone.tail_local - pose_bone.bone.head_local).normalized()
    axis = direction.normalized()

    # Só a parte da palma perpendicular ao antebraço é alcançável: o resto seria
    # pedir para a mão girar em torno de um eixo que ela não tem.
    wanted = palm - axis * palm.dot(axis)
    if wanted.length < 1e-6:
        anim_gait.aim_bone(pose_bone, direction, pose_bone.matrix.translation.copy())
        return
    wanted.normalize()

    swing = rest_dir.rotation_difference(axis)
    current = swing @ anim_climb.REST_PALM
    current = current - axis * current.dot(axis)

    total = swing
    if current.length > 1e-6:
        total = current.normalized().rotation_difference(wanted) @ swing

    matrix = (total.to_matrix() @ rest.to_3x3()).to_4x4()
    matrix.translation = pose_bone.matrix.translation
    pose_bone.matrix = matrix


#: Limite de torção do antebraço, em graus a partir do neutro anatômico.
#:
#: O antebraço humano gira cerca de 85° para pronar e 90° para supinar a partir
#: do neutro (polegar para cima, com o cotovelo dobrado). Passar disso não é pose
#: apertada, é pose **impossível**: o resto vem do ombro, e como aqui a mão é
#: apontada por matriz, o excedente aparece como um pulso torcido — que foi
#: exatamente o defeito da mão direita.
TWIST_LIMIT = 90.0


def _pronation(pose, side: str) -> float:
    """Torção do antebraço na pose atual, em graus a partir do neutro.

    A métrica que faltava neste arquivo. Todas as outras medem **onde** a mão
    está — erro de alvo, escorregamento, envolvimento na madeira — e nenhuma diz
    para que lado ela está virada, porque uma mão de cabeça para baixo encosta na
    peça exatamente igual a uma mão certa. Foi assim que a direita passou meses
    invertida com o relatório inteiro dando zero.

    O neutro sai do próprio cotovelo, e não de uma constante: o cotovelo é uma
    dobradiça, então o eixo dela — `(ombro→cotovelo) × (cotovelo→punho)` — é a
    única referência que acompanha o braço em qualquer pose. Com o braço dobrado
    e o polegar para cima, a palma olha para o meio do corpo, que é esse eixo
    invertido de um lado e ele mesmo do outro. Daí o `sign`: as duas mãos são
    espelhos, e é isso que este arquivo tinha esquecido.

    Devolve o desvio absoluto. Acima de `TWIST_LIMIT` não há pulso que faça.
    """
    upper = pose[f"upperarm.{side}"].matrix.translation
    elbow = pose[f"lowerarm.{side}"].matrix.translation
    hand = pose[f"hand.{side}"]
    forearm = hand.matrix.translation - elbow
    humerus = elbow - upper
    if forearm.length < 1e-6 or humerus.length < 1e-6:
        return 0.0
    forearm.normalize()
    hinge = humerus.normalized().cross(forearm)
    # Braço reto: não há dobradiça de onde tirar o neutro, e também não há o que
    # julgar — a mão pode girar livre em torno de um braço alinhado.
    if hinge.length < 1e-3:
        return 0.0

    sign = 1.0 if side == "L" else -1.0
    neutral = (hinge.normalized() * sign)
    palm = (hand.matrix.to_3x3() @ hand.bone.matrix_local.to_3x3().inverted()
            @ anim_climb.REST_PALM)
    palm -= forearm * palm.dot(forearm)
    if palm.length < 1e-6:
        return 0.0
    return math.degrees(neutral.angle(palm.normalized()))


#: Por onde a mão chega ao punho: **de frente para a roda**, sempre.
#:
#: A escada podia deixar a mão continuar o antebraço, e o `anim_climb` deixa. Aqui
#: não dá, e o motivo é o roll: a palma tem de ser perpendicular ao eixo da peça,
#: e ela só é **exatamente** alcançável se a mão também for. Com a mão seguindo o
#: antebraço, o `_aim_hand` tinha de projetar a palma desejada no que sobrava, o
#: erro dava até 7° e mudava de quadro para quadro conforme o cotovelo se
#: reacomodava — a medição achou **1,7 cm** de palma andando sobre a madeira com
#: a mão supostamente presa.
#:
#: Com a mão travada em -Y, a palma cai exata na tangente da roda e o
#: escorregamento vira zero por construção. De quebra o punho (a articulação)
#: passa a ficar 7 cm **atrás** do plano da roda em todo quadro, o que tira o
#: antebraço de dentro do aro e do raio que ele estava atravessando.
#:
#: O preço é o pulso, que deixa de continuar o antebraço e passa a dobrar. É o
#: que uma mão que segura um cilindro faz de verdade, e `build` mede o ângulo.
HAND_APPROACH = Vector((0.0, -1.0, 0.0))

#: Quanto a mão relaxa para a direção do antebraço no meio da viagem de volta.
#:
#: Travada de frente para a roda a mão está certa **enquanto segura**, e absurda
#: enquanto viaja: com o braço recolhido para trás, manter a mão apontando para a
#: roda pede 80° de pulso, que nenhum pulso tem. Presa, a exigência vale; solta,
#: não há palma nenhuma para acertar, então a mão simplesmente segue o antebraço
#: e volta a se alinhar antes de tocar a madeira de novo.
WRIST_RELAX = 0.80


def _pose_arm(pose, data: dict, side: str, target: Vector,
              palm: Vector, relax: float = 0.0) -> tuple:
    """Um braço por IK, com a **palma** em *target*.

    Devolve (erro, extensão, palma, dobra do pulso em graus).

    A cadeia resolvida é ombro→cotovelo→**punho**, e não ombro→palma como no
    `anim_climb`: aqui a mão não continua o antebraço (ver `HAND_APPROACH`), então
    ela não pode entrar na conta como um pedaço dele. O alvo do punho é a palma
    recuada de `HAND_GRIP_REACH` na direção de chegada — o que, com a mão de
    frente para a roda, é simplesmente 7 cm para trás do plano.
    """
    sign = 1.0 if side == "L" else -1.0
    upper = pose[f"upperarm.{side}"]
    shoulder = upper.matrix.translation.copy()

    wrist = target - HAND_APPROACH * HAND_GRIP_REACH
    reach = data["humerus"] + data["forearm"]
    extension = (wrist - shoulder).length / reach

    elbow = anim_gait.solve_leg(shoulder, wrist, data["humerus"], data["forearm"],
                                ARM_EXTENSION_LIMIT,
                                Vector((sign * ELBOW_HINT[0], ELBOW_HINT[1],
                                        ELBOW_HINT[2])))
    anim_gait.aim_bone(upper, elbow - shoulder, shoulder)
    bpy.context.view_layer.update()

    lower = pose[f"lowerarm.{side}"]
    anim_gait.aim_bone(lower, wrist - elbow, lower.matrix.translation.copy())
    bpy.context.view_layer.update()

    forearm_dir = (wrist - elbow).normalized()
    approach = (HAND_APPROACH * (1.0 - relax) + forearm_dir * relax).normalized()

    hand = pose[f"hand.{side}"]
    _aim_hand(hand, approach, palm)
    bpy.context.view_layer.update()

    # Onde a palma foi parar **de fato**, depois de a IK ter dito o que podia
    # fazer. É a distância deste ponto ao alvo que denuncia braço curto demais.
    got = hand.matrix.translation + approach * HAND_GRIP_REACH
    bend = math.degrees(forearm_dir.angle(approach))
    return (got - target).length, extension, got, bend


def _pose_hand_grip(pose, side: str, closed: float) -> None:
    """Fecha os dedos sobre o punho.

    As rotações são de eixo-do-mundo **na pose de repouso**, então continuam
    valendo com o braço em qualquer posição — é o que permite fechar a mão sem
    saber para onde ela está apontando.
    """
    sign = 1.0 if side == "L" else -1.0
    for name in FINGERS:
        for i, curl in enumerate(FINGER_CURL, start=1):
            bone = pose.get(f"finger_{name}_0{i}.{side}")
            if bone is not None:
                bone.rotation_quaternion = anim_gait.world_rotation(
                    bone, [("Y", sign * curl * closed)])
    for i, curl in enumerate(THUMB_CURL, start=1):
        bone = pose.get(f"thumb_0{i}.{side}")
        if bone is not None:
            bone.rotation_quaternion = anim_gait.world_rotation(
                bone, [("Z", -sign * curl * closed)])


# -- montagem -----------------------------------------------------------------


def _snap(values: list[float]) -> float:
    """Maior salto entre quadros vizinhos, em fração da excursão do ciclo.

    A medida do "seco", e ela precisa ser **normalizada** para dizer alguma
    coisa: um corpo que se mexe muito tem saltos grandes por quadro sem ter
    tranco nenhum, e o clipe antigo, que quase não se mexia, tinha o pior tranco
    possível justamente porque a pouca coisa que fazia, fazia de uma vez.

    - **1,0** é degrau: a excursão inteira num quadro só. Era o que o corpo lido
      do `hold` binário dava, quatro vezes por ciclo;
    - **0,126** (`π/25`) é o piso de uma volta contínua amostrada nos 25 quadros
      deste ciclo — abaixo disso não existe, com senoide nenhuma.
    """
    span = max(values) - min(values)
    if span < 1e-9:
        return 0.0
    n = len(values)
    return max(abs(values[(i + 1) % n] - values[i]) for i in range(n)) / span


def _key_frame(arm, frame: int) -> None:
    """Grava a pose, com dedos, polegares e clavículas.

    O `anim_gait._key_frame` leva 21 ossos e **não leva a clavícula**. Aqui o
    ombro projeta até 21°, e é sobre o ombro projetado que a IK do braço resolve
    a pose: sem gravá-la, a action reproduz o braço com o ombro em repouso, a mão
    sai cinco centímetros do lugar e agarra o ar — com as métricas do `build`
    continuando a dar zero, porque elas medem a pose **construída**. É por isso
    que `verify()` existe e relê a action.
    """
    anim_climb._key_frame(arm, frame)


def build(variant: Stand = INTACT, arm=None) -> dict:
    """Gera a action do timão e devolve as medidas que provam que ela presta."""
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    metrics = anim_gait.rest_metrics(arm)
    arms = anim_climb.arm_metrics(arm)

    scene = bpy.context.scene
    scene.render.fps = FPS
    # Começa no quadro 0: o exportador glTF divide o número do quadro pelo fps, e
    # começar no 1 punha o primeiro keyframe em t = 0,033 s.
    scene.frame_start = 0
    scene.frame_end = CYCLE_FRAMES

    anim_gait.clear_pose(arm)
    action = anim_climb._new_action(arm, variant.action)

    pose = arm.pose.bones
    # Os pés ficam **parados** o ciclo inteiro: o timoneiro não anda, o corpo é
    # que se move por cima deles. A altura sai do próprio rig em repouso, então a
    # sola encosta no convés sem número escolhido à mão.
    ankles = {
        side: Vector((
            (1.0 if side == "L" else -1.0) * variant.foot_x,
            arm.data.bones[f"foot.{side}"].head_local.y
            - (1.0 if side == "L" else -1.0) * variant.foot_stagger,
            arm.data.bones[f"foot.{side}"].head_local.z,
        ))
        for side in ("L", "R")
    }

    report = {
        "hand_error": 0.0, "arm_extension": 0.0, "leg_extension": 0.0,
        "foot_error": 0.0, "demand": 0.0, "hand_gap": 9.0, "wrist": 0.0,
        "twist": 0.0,
    }
    #: O ciclo inteiro do corpo de uma vez, para medir a lisura dele antes de
    #: gravar qualquer quadro. Ver `_snap`.
    plans = [body_plan(variant, f / CYCLE_FRAMES) for f in range(CYCLE_FRAMES)]
    #: Onde a palma esteve **no referencial do punho** durante cada apoio. Com o
    #: punho girando e a mão presa, essas coordenadas têm de ficar constantes: é
    #: daqui que sai a prova de que nada escorrega.
    held: dict[str, list] = {}

    for frame in range(0, CYCLE_FRAMES + 1):
        t = (frame % CYCLE_FRAMES) / CYCLE_FRAMES
        scene.frame_set(frame)

        plan = plans[frame % CYCLE_FRAMES]
        _aim_root(variant, pose["root"], plan)
        bpy.context.view_layer.update()
        _pose_torso(pose, plan)
        bpy.context.view_layer.update()

        # Alvo e palma saem só da roda: não dependem de onde o ombro está, o que
        # tira daqui a circularidade de "o ombro projeta pelo que a mão precisa,
        # e a mão precisa do que o ombro decidiu".
        targets = {side: grip_target(variant, hand, t)
                   for side, hand in HANDS.items()}
        palms = {side: palm_direction(side, hand.handle_angle(t))
                 for side, hand in HANDS.items()}

        demand = _pose_clavicles(variant, pose, plan, targets)
        bpy.context.view_layer.update()
        report["demand"] = max(report["demand"], max(demand.values()))

        for side in ("L", "R"):
            error, extension = _pose_leg(pose, metrics[side], side,
                                         ankles[side], variant.foot_splay)
            report["foot_error"] = max(report["foot_error"], error)
            report["leg_extension"] = max(report["leg_extension"], extension)

        for side, hand in HANDS.items():
            relax = WRIST_RELAX * math.sin(math.pi * hand.travel(t))
            error, extension, got, bend = _pose_arm(pose, arms[side], side,
                                                    targets[side], palms[side],
                                                    relax)
            report["arm_extension"] = max(report["arm_extension"], extension)
            _pose_hand_grip(pose, side, hand.closure(t))

            k = hand.hold(t)
            if k is not None:
                # Erro e pulso só interessam com a mão **presa**: solta, não há
                # madeira para acertar nem palma para orientar.
                report["hand_error"] = max(report["hand_error"], error)
                report["wrist"] = max(report["wrist"], bend)
                report["twist"] = max(report["twist"], _pronation(pose, side))
                angle = hand.handle_angle(t)
                held.setdefault(side, []).append(_into_handle(variant, angle, got))

        report["hand_gap"] = min(report["hand_gap"],
                                 (targets["L"] - targets["R"]).length)

        bpy.context.view_layer.update()
        _key_frame(arm, frame)

    anim_gait._linear_curves(action)
    scene.frame_set(0)

    slip = 0.0
    for coords in held.values():
        for axis in range(3):
            values = [c[axis] for c in coords]
            slip = max(slip, max(values) - min(values))

    plane_gap = variant.stand - 0.2475      # barriga a 24,75 cm à frente do eixo
    return {
        "variant": variant.name,
        "action": variant.action,
        "fps": FPS,
        "frames": CYCLE_FRAMES,
        "cycle_seconds": round(CYCLE_FRAMES / FPS, 3),
        "cycle_degrees": HANDLE_PITCH,
        "stand_m": variant.stand,
        # Quanto do ciclo cada regime ocupa. O vão é o preço de as duas mãos não
        # disputarem o mesmo punho; ver `HAND_GAP`.
        "both_hands_pct": round(100.0 * (HAND_STANCE - GRAB_PHASE_L), 1),
        "one_hand_pct": round(100.0 * (1.0 - HAND_GAP
                                       - (HAND_STANCE - GRAB_PHASE_L)), 1),
        "no_hand_pct": round(100.0 * HAND_GAP, 1),
        "grab_angle_R": round(GRAB_R, 2),
        "grab_angle_L": round(GRAB_L, 2),
        "arc_R": (round(GRAB_R - SWING, 1), round(GRAB_R, 1)),
        "arc_L": (round(GRAB_L - SWING, 1), round(GRAB_L, 1)),
        # Quanto cada mão pega fora da grade dos oito punhos. Tem de ser zero:
        # é o que garante que ela cai em madeira desenhada. Ver `GRAB_R`.
        "off_grid_deg": (round((GRAB_R - HANDLE_ZERO) % HANDLE_PITCH, 3),
                         round((GRAB_L - HANDLE_ZERO
                                + HANDLE_PITCH * GRAB_PHASE_L) % HANDLE_PITCH, 3)),
        # E quanto cada arco ficou do azimute ótimo do ombro. Ver `SPLAY_R`.
        "splay_deg": (round(SPLAY_R, 1), round(SPLAY_L, 1)),
        # Se a IK não alcançou o alvo, a pose que se vê não é a que está descrita.
        "hand_error_mm": round(report["hand_error"] * 1000, 3),
        "foot_error_mm": round(report["foot_error"] * 1000, 3),
        # Quanto a palma andou **em relação ao punho** durante o apoio.
        "hand_slip_mm": round(slip * 1000, 3),
        "arm_extension_max": round(report["arm_extension"], 3),
        "leg_extension_max": round(report["leg_extension"], 3),
        "reach_demand_max": round(report["demand"], 3),
        # Quanto o pulso dobra em relação ao antebraço. Acima de ~60° a pose
        # deixa de ser possível num pulso humano.
        "wrist_bend_max_deg": round(report["wrist"], 1),
        # E quanto o antebraço **torce** para pôr a palma onde ela tem de estar.
        # É a medida que denuncia mão espelhada; ver `_pronation`.
        "forearm_twist_max_deg": round(report["twist"], 1),
        "forearm_twist_ok": report["twist"] <= TWIST_LIMIT,
        # Distância mínima entre as duas palmas: é o que impede as mãos de se
        # atravessarem na troca.
        "hand_separation_min_cm": round(report["hand_gap"] * 100, 1),
        # Quanto o corpo **se move** no ciclo. O clipe antigo não tinha nada em
        # vertical: o timoneiro girava a roda de um posto congelado.
        "body_rise_mm": round(
            (max(p["lift"] for p in plans) - min(p["lift"] for p in plans)) * 1000, 1),
        "body_sway_mm": round(
            (max(p["sway"] for p in plans) - min(p["sway"] for p in plans)) * 1000, 1),
        "body_twist_deg": round(
            max(p["twist"] for p in plans) - min(p["twist"] for p in plans), 1),
        # E o quão liso é esse movimento. Ver `_snap`: 1,0 é degrau, 0,126 é o
        # melhor que 25 quadros permitem.
        "body_snap_max": round(max(
            _snap([p[key] for p in plans])
            for key in ("sway", "surge", "lift", "twist", "pelvis_yaw")), 3),
        "belly_to_wheel_cm": round(plane_gap * 100, 1),
        "note": variant.note,
    }


def run(arm=None) -> dict:
    """Constrói as duas variantes e devolve a bancada inteira de medidas.

    É o ponto de entrada da pasta, no feitio dos irmãos: uma chamada gera as
    actions e responde, com números medidos da **malha deformada**, se elas
    prestam. Nada aqui afina no olho — o olho serve para escolher entre A e B,
    que é a única decisão que este arquivo deixa em aberto.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    report = {}
    for name, variant in VARIANTS.items():
        report[name] = {
            "build": build(variant, arm),
            "verify": verify(variant, arm),
            "clearance": clearance(variant, arm),
            "sweep": sweep_check(variant, arm),
            "window": reach_window(variant),
        }
    return report


def _into_handle(variant: Stand, angle: float, point: Vector) -> tuple:
    """Coordenadas de *point* no referencial do punho de ângulo *angle*.

    Três eixos: ao longo da peça, perpendicular a ela no plano da roda, e
    perpendicular ao plano. Com a mão presa, os três têm de ficar parados — se
    algum anda, a mão está escorregando na madeira enquanto a roda gira.
    """
    origin = handle_point(variant, angle)
    axis = handle_axis(angle)
    plane = Vector((0.0, 1.0, 0.0))              # normal do plano da roda
    tangent = axis.cross(plane)
    delta = point - origin
    return (delta.dot(axis), delta.dot(tangent), delta.dot(plane))


# -- conferência do que ficou gravado -----------------------------------------


def verify(variant: Stand = INTACT, arm=None) -> dict:
    """Mede o contato **relendo a action**, com a malha deformada de verdade.

    Existe porque as métricas do `build` já mentiram uma vez nesta pasta: elas
    medem a pose no instante em que é construída, e entre construir e gravar há
    um `_key_frame` que só leva os ossos que alguém lembrou de listar. Quando a
    clavícula ficou de fora do clipe da escada, o `build` reportava contato
    perfeito e o personagem agarrava o ar cinco centímetros ao lado da barra.

    Aqui não há pose construída: troca-se o quadro, deixa-se o Blender avaliar a
    action e mede-se a **geometria da mão** contra o cilindro do punho. A
    distância deixa de ser um `hypot` de duas componentes, como na escada — lá as
    barras são paralelas ao eixo X —, e vira distância ponto-segmento ao eixo do
    punho, que aponta para onde a roda mandar.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    obj = bpy.data.objects[anim_gait.MESH_NAME]
    anim_climb._assign_action(arm, variant.action)

    names = {g.index: g.name for g in obj.vertex_groups}
    hand_verts = {"L": [], "R": []}
    #: Só a **palma** entra no escorregamento, e os dedos ficam de fora de
    #: propósito: eles abrem e fecham durante o apoio (ver `Hand.closure`), então
    #: o centroide da mão inteira anda 7,6 mm por causa da própria pega e não de
    #: deslize nenhum. Quem tem de ficar cravado na madeira é a palma.
    palm_verts = {"L": [], "R": []}
    for vert in obj.data.vertices:
        best, group = 0.0, ""
        for g in vert.groups:
            if g.weight > best:
                best, group = g.weight, names[g.group]
        for side in ("L", "R"):
            if not group.endswith(f".{side}"):
                continue
            if any(k in group for k in ("hand", "finger", "thumb")):
                hand_verts[side].append(vert.index)
            if group.startswith("hand"):
                palm_verts[side].append(vert.index)

    scene = bpy.context.scene
    worst_wrap, loose, palm_deep = -9.0, -9.0, -9.0
    #: O polegar contra o eixo do punho, e a torção do antebraço. As duas
    #: existem por causa da mão direita invertida: ela encostava na madeira com
    #: precisão de décimo de milímetro, de cabeça para baixo, e nenhuma das
    #: outras medidas deste arquivo tinha como reclamar. Ver `palm_direction`.
    thumb_along, twist = 9.0, -9.0
    tracks: dict[str, list] = {}
    for frame in range(CYCLE_FRAMES):
        t = frame / CYCLE_FRAMES
        scene.frame_set(frame)
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        for side, hand in HANDS.items():
            if hand.hold(t) is None:
                continue
            axis = handle_axis(hand.handle_angle(t))
            thumb = (arm.pose.bones[f"thumb_02.{side}"].matrix.translation
                     - arm.pose.bones[f"thumb_01.{side}"].matrix.translation)
            if thumb.length > 1e-6:
                thumb_along = min(thumb_along, thumb.normalized().dot(axis))
            twist = max(twist, _pronation(arm.pose.bones, side))
            angle = hand.handle_angle(t)
            a = handle_point(variant, angle, HANDLE_INNER)
            b = handle_point(variant, angle, HANDLE_OUTER)

            near = 9.0
            for i in hand_verts[side]:
                gap = _segment_distance(mesh.vertices[i].co, a, b) - HANDLE_RADIUS
                near = min(near, gap)
            for i in palm_verts[side]:
                gap = _segment_distance(mesh.vertices[i].co, a, b) - HANDLE_RADIUS
                palm_deep = max(palm_deep, -gap)

            centroid = Vector((0.0, 0.0, 0.0))
            for i in palm_verts[side]:
                centroid += mesh.vertices[i].co
            centroid /= len(palm_verts[side])
            tracks.setdefault(side, []).append(_into_handle(variant, angle, centroid))

            # `near` positivo é mão flutuando: a pega não encosta na madeira.
            #
            # Só conta com a pega **fechada**: os últimos quadros do apoio são a
            # soltura, e ali `Hand.closure` já está abrindo os dedos de propósito.
            # Cobrar contato neles condenaria a única parte do ciclo que tem de
            # perdê-lo.
            if hand.closure(t) >= 0.95:
                loose = max(loose, near)
            worst_wrap = max(worst_wrap, -near)
        evaluated.to_mesh_clear()
    scene.frame_set(0)

    slip = 0.0
    for coords in tracks.values():
        for axis in range(3):
            values = [c[axis] for c in coords]
            slip = max(slip, max(values) - min(values))

    return {
        "variant": variant.name,
        # Quanto a mão envolve o punho, em cm. Tem de ser positivo: a concha
        # fecha *sobre* a madeira, então há sobreposição por construção. Mas não
        # pode passar do raio (4,75 cm) — aí a ponta do dedo sai pelo outro lado.
        "grip_wrap_cm": round(worst_wrap * 100, 2),
        # A palma é outra conversa: ela **encosta**, não atravessa.
        "palm_into_wood_cm": round(palm_deep * 100, 2),
        # E nenhum quadro de apoio pode ter a mão solta no ar.
        "worst_loose_cm": round(loose * 100, 2),
        # Escorregamento da palma medido na **malha deformada**, no referencial
        # do punho: com a mão presa e a roda girando, tem de ficar parado.
        "palm_slip_mm": round(slip * 1000, 2),
        # Polegar contra o eixo do punho, no pior quadro das duas mãos. Os dois
        # arcos ficam acima do cubo, então o raio aponta para cima e o polegar
        # tem de subir com ele: **positivo nas duas mãos**. Negativo é mão
        # espelhada — era −0,67 na direita antes de `PALM_SIGN` existir.
        "thumb_along_spoke_min": round(thumb_along, 3),
        "thumb_up_both_hands": thumb_along > 0.0,
        # E a torção que o antebraço precisou para chegar lá. Ver `_pronation`.
        "forearm_twist_max_deg": round(twist, 1),
        "forearm_twist_ok": twist <= TWIST_LIMIT,
        "frames_measured": CYCLE_FRAMES,
    }


def sweep_check(variant: Stand = INTACT, arm=None, steps: int = 361) -> dict:
    """Percorre o leme de batente a batente e mede a mão contra o punho **mais
    próximo que existe**, em cada ângulo.

    É a prova do arquivo, e a única que vale: `verify()` mede um ciclo, e um
    ciclo é onde tudo foi construído. O que precisa ser demonstrado é o resto —
    que a mesma pose serve para os 360° do curso, com a roda em qualquer lugar
    entre os batentes.

    Três coisas que este teste faz e o `verify()` não:

    - varre a fase **fora da grade de quadros**, com `frame_set(subframe=...)`,
      que é a interpolação linear que o three.js vai fazer. Uma fase que só
      funcionasse nos 25 quadros gravados passaria no `verify()` e falharia no
      jogo;
    - não assume qual punho a mão deveria estar segurando: procura o **mais
      próximo entre os oito**, que é o que o olho faz;
    - roda a roda de verdade a cada passo, então um erro de sinal em
      `handle_point` ou em `spin` aparece como a mão andando para um lado e a
      madeira para o outro.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    obj = bpy.data.objects[anim_gait.MESH_NAME]
    anim_climb._assign_action(arm, variant.action)

    names = {g.index: g.name for g in obj.vertex_groups}
    palm_verts = {"L": [], "R": []}
    grip_verts = {"L": [], "R": []}
    for vert in obj.data.vertices:
        best, group = 0.0, ""
        for g in vert.groups:
            if g.weight > best:
                best, group = g.weight, names[g.group]
        for side in ("L", "R"):
            if group == f"hand.{side}":
                palm_verts[side].append(vert.index)
            if group.endswith(f".{side}") and any(
                    k in group for k in ("hand", "finger", "thumb")):
                grip_verts[side].append(vert.index)

    scene = bpy.context.scene
    worst_loose, holds = -9.0, 0
    span = {"L": [9.0, -9.0], "R": [9.0, -9.0]}
    for step in range(steps):
        wheel = -180.0 + 360.0 * step / (steps - 1)
        phase = (wheel / HANDLE_PITCH) % 1.0
        exact = phase * CYCLE_FRAMES
        scene.frame_set(int(exact), subframe=exact - int(exact))
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        for side, hand in HANDS.items():
            if hand.hold(phase) is None:
                continue
            holds += 1
            centroid = Vector((0.0, 0.0, 0.0))
            for i in palm_verts[side]:
                centroid += mesh.vertices[i].co
            centroid /= len(palm_verts[side])

            # O punho mais próximo entre os oito que a roda desenhou **neste
            # ângulo de leme** — não o que a conta do ciclo diz que deveria ser.
            near, closest = 9.0, None
            for i in range(HANDLE_COUNT):
                angle = HANDLE_ZERO + i * HANDLE_PITCH - wheel
                a = handle_point(variant, angle, HANDLE_INNER)
                b = handle_point(variant, angle, HANDLE_OUTER)
                gap = _segment_distance(centroid, a, b)
                if gap < near:
                    near, closest = gap, (a, b)
            span[side][0] = min(span[side][0], near)
            span[side][1] = max(span[side][1], near)

            # O contato é medido na **geometria**, e não no centroide: o centro
            # do punho fechado fica alguns centímetros do eixo da madeira, e essa
            # diferença é viés — ela mudou 4,8 cm no dia em que a palma da mão
            # direita passou para o outro lado da peça, sem que um milímetro de
            # contato tivesse mudado. Serve para achar o punho; não serve para
            # dizer se a mão o está tocando.
            #
            # Como em `verify`, só conta com a pega fechada: os últimos quadros
            # do apoio são a soltura, e ali a mão tem de perder o contato.
            if hand.closure(phase) >= 0.95:
                touch = 9.0
                for i in grip_verts[side]:
                    touch = min(touch, _segment_distance(
                        mesh.vertices[i].co, closest[0], closest[1]))
                worst_loose = max(worst_loose, touch - HANDLE_RADIUS)
        evaluated.to_mesh_clear()
    scene.frame_set(0)

    return {
        "variant": variant.name,
        "rudder_travel_deg": 360.0,
        "steps": steps,
        "hand_holds_sampled": holds,
        # Quanto a mão **encosta** na madeira, no pior ponto do curso: distância
        # do vértice mais próximo da mão à superfície do punho. Negativo é a
        # concha fechada sobre a peça, que é o certo; positivo seria mão no ar a
        # algum ângulo de leme.
        "worst_grip_gap_cm": round(worst_loose * 100, 2),
        # E o quanto a mão **deriva** ao longo dos 360°, pelo centroide. Medido
        # como amplitude, e não como desvio de um nominal, justamente porque o
        # viés acima existe: se a fase e o ângulo não casassem, a mão iria
        # andando punho afora e isto cresceria sem parar.
        "grip_drift_over_travel_mm": round(
            max(hi - lo for lo, hi in span.values()) * 1000, 2),
    }


def _segment_distance(point: Vector, a: Vector, b: Vector) -> float:
    """Distância de *point* ao segmento *a*—*b*."""
    axis = b - a
    length2 = axis.length_squared
    if length2 < 1e-12:
        return (point - a).length
    k = min(max((point - a).dot(axis) / length2, 0.0), 1.0)
    return (point - (a + axis * k)).length


# -- o corpo contra a roda ----------------------------------------------------


#: Peças que **têm** de tocar a madeira. Medi-las como colisão condenaria toda
#: pegada boa.
TOUCHING = ("hand", "finger", "thumb")

#: Membros, que é outra conversa do tronco — e a diferença não é de grau.
#:
#: Tronco encostando na roda é defeito de verdade: significa que o timoneiro está
#: perto demais e atravessa o cenário no meio da tela. Já o antebraço **precisa**
#: chegar ao plano da roda para pousar a mão no punho, e a borda larga de uma
#: manga vai raspar o raio que ela está segurando em algum quadro. É a mesma
#: interpenetração que este personagem já tem entre bota e calça.
#:
#: O que não cai em `TOUCHING` nem aqui é tronco, e é medido como tal.
LIMBS = ("thigh", "calf", "upperarm", "lowerarm", "foot", "toe")


def clearance(variant: Stand = INTACT, arm=None) -> dict:
    """Quanto o corpo entra na roda e no cavalete, quadro a quadro.

    É o `anim_climb.clearance` virado de lado. Lá a escada é fixa e o corpo sobe;
    aqui o corpo é fixo e a **roda gira**, então os oito punhos passam por
    posições diferentes a cada quadro e a peça que ameaça o joelho num instante
    está do outro lado no seguinte.

    A malha é lida **deformada**, porque é a pose que colide, não o rig.
    """
    arm = arm or bpy.data.objects[anim_gait.ARMATURE_NAME]
    obj = bpy.data.objects[anim_gait.MESH_NAME]
    anim_climb._assign_action(arm, variant.action)

    def dominant(vert) -> str:
        best, group = 0.0, ""
        for g in vert.groups:
            if g.weight > best:
                best, group = g.weight, obj.vertex_groups[g.group].name
        if any(k in group for k in TOUCHING):
            return "touching"
        if any(k in group for k in LIMBS):
            return "limb"
        return "core"

    kind = {v.index: dominant(v) for v in obj.data.vertices}

    scene = bpy.context.scene
    worst = {"core": (-9.0, None), "limb": (-9.0, None)}
    for frame in range(CYCLE_FRAMES):
        wheel = HANDLE_PITCH * frame / CYCLE_FRAMES     # graus de roda já rodados
        scene.frame_set(frame)
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        for vert in mesh.vertices:
            group = kind[vert.index]
            if group == "touching":
                continue
            gap = _helm_penetration(variant, vert.co, wheel)
            if gap > worst[group][0]:
                worst[group] = (gap, (frame, round(vert.co.x, 3),
                                      round(vert.co.y, 3), round(vert.co.z, 3)))
        evaluated.to_mesh_clear()
    scene.frame_set(0)

    return {
        "variant": variant.name,
        # Positivo é madeira dentro do pirata; negativo é folga.
        "core_penetration_cm": round(worst["core"][0] * 100, 2),
        "core_worst_frame": worst["core"][1],
        "limb_penetration_cm": round(worst["limb"][0] * 100, 2),
        "limb_worst_frame": worst["limb"][1],
    }


def _helm_penetration(variant: Stand, point: Vector, wheel: float) -> float:
    """Quanto *point* está **dentro** do timão, com a roda girada de *wheel* graus.

    Positivo é penetração. Cobre o que um corpo pode alcançar: aro, os oito
    punhos, cubo, travessa do cavalete, tambor do leme, os dois mancais de ferro
    e os montantes. A bitácula fica 1,05 m à frente da roda e não entra.
    """
    plane_y = -variant.stand
    x, y, z = point.x, point.y, point.z
    dy = y - plane_y
    radial = math.hypot(x, z - HUB_Z)

    # Aro: toro de eixo Y.
    gap = RIM_TUBE - math.hypot(radial - WHEEL_RADIUS, dy)
    # Cubo: cilindro curto de eixo Y.
    gap = max(gap, min(HUB_RADIUS - radial, HUB_HALF - abs(dy)))
    # Punhos, na posição em que a roda os pôs neste quadro.
    for i in range(HANDLE_COUNT):
        angle = HANDLE_ZERO + i * HANDLE_PITCH - wheel
        a = handle_point(variant, angle, HANDLE_INNER)
        b = handle_point(variant, angle, HANDLE_OUTER)
        gap = max(gap, HANDLE_RADIUS - _segment_distance(point, a, b))
    # Travessa do cavalete: caixa.
    gap = max(gap, min(CROSSBAR_HALF[0] - abs(x),
                       CROSSBAR_HALF[1] - abs(dy),
                       CROSSBAR_HALF[2] - abs(z - CROSSBAR_Z)))
    # Tambor do leme: cilindro de eixo X.
    gap = max(gap, min(DRUM_RADIUS - math.hypot(dy, z - HUB_Z),
                       DRUM_HALF_X - abs(x)))
    # Mancais: barras de ferro de eixo X, na altura do cubo.
    for side in (1.0, -1.0):
        a = Vector((side * BEARING_INNER_X, plane_y, HUB_Z))
        b = Vector((side * BEARING_OUTER_X, plane_y, HUB_Z))
        gap = max(gap, BEARING_RADIUS - _segment_distance(point, a, b))
    # Montantes.
    for side in (1.0, -1.0):
        gap = max(gap, min(POST_HALF[0] - abs(x - side * POST_X),
                           POST_HALF[1] - abs(dy),
                           min(z, POST_TOP_Z - z)))
    return gap


# -- a janela de pega ---------------------------------------------------------


def reach_window(variant: Stand = INTACT, step: float = 1.0) -> dict:
    """Que punhos o cavalete deixa livres, e quais o braço alcança.

    Duas perguntas diferentes, medidas juntas porque a resposta útil é a
    interseção. A primeira é geométrica e não depende de pose: um punho está
    obstruído quando a **mão** que fosse pegá-lo teria de ocupar espaço já
    tomado pela travessa, pelo tambor ou pelos mancais. A segunda é a que este
    arquivo passou o tempo todo perseguindo.
    """
    free, reachable = [], []
    shoulder = Vector((-SHOULDER_X, 0.0, SHOULDER_Z))
    angle = 0.0
    while angle < 360.0:
        centre = handle_point(variant, angle)
        # Uma esfera de 7 cm no lugar da mão, medida só contra as peças **fixas**
        # do cavalete: contra a roda inteira toda pega daria colisão, já que o
        # punho que se quer pegar faz parte dela.
        blocked = _frame_penetration(variant, centre) > -0.070
        if not blocked:
            free.append(angle)
            if (centre - shoulder).length <= ARM_REACH:
                reachable.append(angle)
        angle += step

    def spans(values):
        out, run = [], []
        for v in values:
            if run and v - run[-1] > step * 1.5:
                out.append((run[0], run[-1]))
                run = []
            run.append(v)
        if run:
            out.append((run[0], run[-1]))
        return out

    return {
        "variant": variant.name,
        "free_spans_deg": spans(free),
        "reachable_rest_spans_deg": spans(reachable),
        "arcs_used": {"R": (round(GRAB_R - SWING, 1), round(GRAB_R, 1)),
                      "L": (round(GRAB_L - SWING, 1), round(GRAB_L, 1))},
    }


def _frame_penetration(variant: Stand, point: Vector) -> float:
    """Penetração só nas peças **fixas** do cavalete, sem a roda."""
    plane_y = -variant.stand
    x, y, z = point.x, point.y, point.z
    dy = y - plane_y
    gap = min(CROSSBAR_HALF[0] - abs(x), CROSSBAR_HALF[1] - abs(dy),
              CROSSBAR_HALF[2] - abs(z - CROSSBAR_Z))
    gap = max(gap, min(DRUM_RADIUS - math.hypot(dy, z - HUB_Z),
                       DRUM_HALF_X - abs(x)))
    for side in (1.0, -1.0):
        a = Vector((side * BEARING_INNER_X, plane_y, HUB_Z))
        b = Vector((side * BEARING_OUTER_X, plane_y, HUB_Z))
        gap = max(gap, BEARING_RADIUS - _segment_distance(point, a, b))
        gap = max(gap, min(POST_HALF[0] - abs(x - side * POST_X),
                           POST_HALF[1] - abs(dy), min(z, POST_TOP_Z - z)))
    return gap


# -- preview ------------------------------------------------------------------


def _box(verts, faces, centre: Vector, half: Vector) -> None:
    base = len(verts)
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                verts.append(Vector((centre.x + sx * half.x,
                                     centre.y + sy * half.y,
                                     centre.z + sz * half.z)))
    # Ordem dos vértices acima: bit 2 = x, bit 1 = y, bit 0 = z.
    quads = ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1),
             (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3))
    for q in quads:
        faces.append(tuple(base + i for i in q))


#: Prefixo de tudo o que o preview cria. Dois underscores para não colidir com o
#: `_` das actions-andaime, que o `export.py` já varre.
SCAFFOLD = "__HelmPreview"


def _purge() -> None:
    """Apaga andaimes de preview que tenham sobrado de uma execução anterior.

    Sem isto o `render` fica **não idempotente** do pior jeito: a roda velha
    continua na cena, o Blender dá `.001` à nova, e o quadro sai com duas rodas
    sobrepostas em ângulos diferentes. Como as duas variantes ficam a distâncias
    diferentes do timoneiro, o sintoma é uma segunda coluna de madeira flutuando
    ao lado da primeira — que foi exatamente o que apareceu na primeira leva de
    previews deste arquivo.
    """
    for collection in (bpy.data.objects, bpy.data.meshes, bpy.data.materials):
        for datablock in list(collection):
            if datablock.name.startswith(SCAFFOLD):
                collection.remove(datablock)


def _temp_wheel(variant: Stand):
    """A roda do timão, só para o preview. Devolve o que tem de ser apagado.

    Não é cenário: é **régua**. Um ciclo de timão não se julga com o personagem
    no vazio — sem os punhos no lugar exato onde a conta diz que eles estão, não
    há como ver se a mão pega madeira ou ar. Tudo aqui sai das mesmas constantes
    que o clipe usa, e é isso que faz o preview provar alguma coisa.

    Sai em duas peças: a **roda**, que gira, e o **cavalete**, que não.
    """
    _purge()
    hub = Vector((0.0, -variant.stand, HUB_Z))

    # -- roda (gira) ----------------------------------------------------------
    verts, faces = [], []
    segments = 40
    # Aro: anel de tubos curtos, que é mais simples que um toro e some na
    # silhueta do mesmo jeito.
    ring = []
    for i in range(segments):
        angle = 2.0 * math.pi * i / segments
        ring.append(Vector((-WHEEL_RADIUS * math.cos(angle), 0.0,
                            WHEEL_RADIUS * math.sin(angle))))
    for i in range(segments):
        anim_climb._tube(verts, faces, ring[i], ring[(i + 1) % segments],
                         RIM_TUBE, 6)
    # Cada raio sai em duas peças de faces contadas (6 + 8), porque é dessa
    # contagem que sai o índice de material do punho de latão mais abaixo.
    spoke_start = len(faces)
    for i in range(HANDLE_COUNT):
        angle = HANDLE_ZERO + i * HANDLE_PITCH
        rad = math.radians(angle)
        direction = Vector((-math.cos(rad), 0.0, math.sin(rad)))
        # Raio inteiro, do cubo à ponta do punho: é uma peça só na roda de
        # verdade, e é o raio que vira punho ao passar do aro.
        anim_climb._tube(verts, faces, Vector((0.0, 0.0, 0.0)),
                         direction * HANDLE_INNER, 0.040, 6)
        anim_climb._tube(verts, faces, direction * HANDLE_INNER,
                         direction * HANDLE_OUTER, HANDLE_RADIUS, 8)
    hub_start = len(faces)
    anim_climb._tube(verts, faces, Vector((0.0, -HUB_HALF, 0.0)),
                     Vector((0.0, HUB_HALF, 0.0)), HUB_RADIUS, 14)

    wheel_mesh = bpy.data.meshes.new("__HelmPreviewWheel")
    wheel_mesh.from_pydata([tuple(v) for v in verts], [], faces)
    wheel_mesh.update()

    wood = bpy.data.materials.new("__HelmPreviewWood")
    wood.use_nodes = True
    wood.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = \
        (0.21, 0.14, 0.085, 1.0)
    wood.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85
    brass = bpy.data.materials.new("__HelmPreviewBrass")
    brass.use_nodes = True
    brass.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = \
        (0.72, 0.55, 0.20, 1.0)
    brass.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
    brass.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.35
    wheel_mesh.materials.append(wood)
    wheel_mesh.materials.append(brass)
    # O punho da marca é o do raio zero, e o cubo é de latão: são as duas peças
    # que o jogador usa para saber onde está o leme a meio. O raio zero começa em
    # `spoke_start` e os seus 6 primeiros polígonos são o braço de madeira; o
    # punho são os 8 seguintes.
    for poly in wheel_mesh.polygons[spoke_start + 6:spoke_start + 14]:
        poly.material_index = 1
    for poly in wheel_mesh.polygons[hub_start:]:
        poly.material_index = 1

    wheel = bpy.data.objects.new("__HelmPreviewWheel", wheel_mesh)
    wheel.location = hub
    bpy.context.scene.collection.objects.link(wheel)

    # -- cavalete (parado) ----------------------------------------------------
    verts, faces = [], []
    _box(verts, faces, Vector((0.0, -variant.stand, CROSSBAR_Z)),
         Vector(CROSSBAR_HALF))
    for side in (1.0, -1.0):
        _box(verts, faces,
             Vector((side * POST_X, -variant.stand, POST_TOP_Z * 0.5)),
             Vector((POST_HALF[0], POST_HALF[1], POST_TOP_Z * 0.5)))
        anim_climb._tube(verts, faces,
                         Vector((side * BEARING_OUTER_X, -variant.stand, HUB_Z)),
                         Vector((side * BEARING_INNER_X, -variant.stand, HUB_Z)),
                         BEARING_RADIUS, 8)
    anim_climb._tube(verts, faces,
                     Vector((-DRUM_HALF_X, -variant.stand, HUB_Z)),
                     Vector((DRUM_HALF_X, -variant.stand, HUB_Z)),
                     DRUM_RADIUS, 14)
    # Coluna central, sob o eixo.
    _box(verts, faces, Vector((0.0, -variant.stand, (WHEEL_Y - 0.3 - DECK_Y) * 0.5)),
         Vector((0.13, 0.13, (WHEEL_Y - 0.3 - DECK_Y) * 0.5)))

    frame_mesh = bpy.data.meshes.new("__HelmPreviewFrame")
    frame_mesh.from_pydata([tuple(v) for v in verts], [], faces)
    frame_mesh.update()
    dark = bpy.data.materials.new("__HelmPreviewFrameMat")
    dark.use_nodes = True
    dark.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = \
        (0.14, 0.10, 0.07, 1.0)
    dark.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    frame_mesh.materials.append(dark)
    stand_obj = bpy.data.objects.new("__HelmPreviewFrame", frame_mesh)
    bpy.context.scene.collection.objects.link(stand_obj)

    # O convés, para o olho ter onde apoiar a inclinação do corpo. Só o pedaço
    # que cabe no quadro: uma placa grande demais rouba metade da folha de
    # contato e encolhe o personagem, que é o que se veio julgar.
    verts, faces = [], []
    _box(verts, faces, Vector((0.0, -variant.stand * 0.5, -0.025)),
         Vector((1.15, 0.95, 0.025)))
    deck_mesh = bpy.data.meshes.new("__HelmPreviewDeck")
    deck_mesh.from_pydata([tuple(v) for v in verts], [], faces)
    deck_mesh.update()
    deck_mat = bpy.data.materials.new("__HelmPreviewDeckMat")
    deck_mat.use_nodes = True
    deck_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = \
        (0.32, 0.24, 0.16, 1.0)
    deck_mesh.materials.append(deck_mat)
    deck = bpy.data.objects.new("__HelmPreviewDeck", deck_mesh)
    bpy.context.scene.collection.objects.link(deck)

    return {
        "objects": [wheel, stand_obj, deck],
        "meshes": [wheel_mesh, frame_mesh, deck_mesh],
        "materials": [wood, brass, dark, deck_mat],
        "wheel": wheel,
    }


def _drop(scaffold: dict) -> None:
    for obj in scaffold["objects"]:
        bpy.data.objects.remove(obj)
    for mesh in scaffold["meshes"]:
        bpy.data.meshes.remove(mesh)
    for material in scaffold["materials"]:
        bpy.data.materials.remove(material)


def spin(wheel, degrees: float) -> None:
    """Gira a roda de preview de *degrees* de ângulo de leme.

    O sinal é o do jogo (`model.wheel.rotation.z = -wheelAngle`) traduzido para o
    rig: com o eixo da roda em +Y aqui, girar o objeto de `-wheelAngle` em torno
    de Y leva o punho *i* de `θᵢ` para `θᵢ - wheelAngle`, que é a conta que o
    clipe inteiro usa.
    """
    wheel.rotation_euler = (0.0, -math.radians(degrees), 0.0)


#: Vistas do preview: nome -> (direção do olhar, distância, alvo, esconder o
#: cavalete).
#:
#: O alvo vem como `(x, fração do vão, z)`: a componente em Y é uma **fração da
#: distância do timoneiro à roda**, e não um número absoluto, para que as duas
#: variantes saiam no mesmo enquadramento relativo mesmo com o posto em lugares
#: diferentes. Enquadrar por `view_selected`, como o `anim_climb` faz, não serve
#: aqui: a caixa da seleção muda quando o personagem se inclina, e a comparação
#: A × B viraria uma comparação de molduras.
#:
#: O cavalete some na lateral, e só nela. Os montantes ficam em x = ±0,95 e a
#: câmera, a 3 m no eixo X, cai atrás do mais próximo — e cortá-lo por
#: profundidade não adianta nada, porque numa vista de perfil os **dois**
#: montantes se projetam no mesmo lugar da tela: tapado o de cá, o de lá assume o
#: posto. O quadro que melhor julga a inclinação do corpo é justamente o que uma
#: coluna de madeira cobre inteiro. Sem o cavalete sobram a roda e os punhos, que
#: é o que essa vista tem de mostrar.
#:
#: A câmera é armada **por vetor**, e não por `view_axis` mais órbita como no
#: `anim_climb`. O motivo é a comparação: as duas variantes têm de sair no mesmo
#: enquadramento para que a diferença que o olho vê seja a pose e não a moldura,
#: e `view_selected` reenquadra conforme a caixa da seleção — que muda quando o
#: personagem se inclina.
#:
#: A lateral é a que julga o assunto deste arquivo: é nela que se vê o quanto o
#: personagem teve de se esticar. A de três quartos é o que o jogador vê de fora.
#: A frontal atravessa a roda e mostra a mão caindo — ou não — em cima do punho.
VIEWS = {
    "side": ((1.0, 0.0, -0.05), 2.35, (0.0, 0.45, 1.00), True),
    "quarter": ((0.62, -1.0, -0.26), 2.55, (0.0, 0.45, 1.02), False),
    "over": ((0.0, -1.0, -0.30), 2.35, (0.0, 0.45, 1.05), False),
    "front": ((0.0, 1.0, -0.10), 2.40, (0.0, 0.45, 1.02), False),
    # De perto, por cima e de fora, no alto da roda: é o único quadro em que dá
    # para conferir a olho o que o `verify()` mede em milímetros — se a concha da
    # mão cai em cima da madeira ou ao lado dela.
    "grip": ((0.55, 0.83, -0.35), 1.15, (0.0, 0.92, 1.40), True),
}


def _aim_view(space, variant: Stand, name: str, zoom: float) -> None:
    """Aponta a viewport para a vista *name*, sem depender de operador nenhum."""
    direction, distance, target, _ = VIEWS[name]
    look = Vector(direction).normalized()
    # `to_track_quat('-Z', 'Y')` devolve a rotação cujo -Z (a direção para onde a
    # câmera olha, no Blender) cai em *look*, com +Y da tela para cima.
    space.region_3d.view_rotation = look.to_track_quat("-Z", "Y")
    # O alvo fica entre o peito do timoneiro e o plano da roda: enquadrar só o
    # personagem joga a roda para fora, e enquadrar só a roda corta os pés.
    space.region_3d.view_location = Vector((target[0],
                                            -variant.stand * target[1],
                                            target[2]))
    space.region_3d.view_distance = distance * zoom


def render(out_dir: str, variant: Stand = INTACT, width: int = 520,
           height: int = 640, views=("side", "quarter"), zoom: float = 1.0,
           frames: int | None = None, sweep: bool = False) -> dict:
    """Renderiza o ciclo (ou a varredura inteira) em cada vista, um PNG por quadro.

    Com ``sweep``, em vez de um ciclo sai o curso completo do leme — de batente a
    batente, os 360° que a `MAX_WHEEL` permite, na cadência real de
    `WHEEL_RATE`. É esse preview que prova o clipe: se a re-pega estiver certa, a
    mão cai em cima de um punho **desenhado** nos oito ciclos, e não só naquele
    em que ele foi construído.
    """
    import os

    import anim_preview

    scene = bpy.context.scene
    arm = bpy.data.objects[anim_gait.ARMATURE_NAME]
    mesh = bpy.data.objects[anim_gait.MESH_NAME]
    scaffold = _temp_wheel(variant)
    wheel = scaffold["wheel"]

    if sweep:
        # 360° a 2,1 rad/s = 2,99 s. A fase e o ângulo saem da mesma conta que o
        # runtime fará, então qualquer deriva aparece aqui.
        total = frames or int(round(2.0 * math.pi / 2.1 * FPS))
        shots = [(-180.0 + 360.0 * i / total) for i in range(total + 1)]
    else:
        total = frames or CYCLE_FRAMES
        shots = [HANDLE_PITCH * i / total for i in range(total)]

    win, area, region = anim_preview._viewport()
    space = area.spaces.active

    bpy.ops.object.select_all(action="DESELECT")
    for obj in (mesh, wheel, scaffold["objects"][1]):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh

    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"

    frame_obj = scaffold["objects"][1]
    previous = (space.shading.type, space.overlay.show_overlays,
                arm.animation_data.action if arm.animation_data else None)
    space.shading.type = "MATERIAL"
    space.overlay.show_overlays = False

    written = {}
    try:
        anim_climb._assign_action(arm, variant.action)
        with bpy.context.temp_override(window=win, area=area, region=region):
            for name in views:
                scene.frame_set(0)
                spin(wheel, 0.0)
                frame_obj.hide_viewport = VIEWS[name][3]
                _aim_view(space, variant, name, zoom)

                for index, angle in enumerate(shots):
                    # A fase sai do ângulo, exatamente como no jogo. É esta linha
                    # que o preview existe para provar.
                    phase = (angle / HANDLE_PITCH) % 1.0
                    scene.frame_set(int(round(phase * CYCLE_FRAMES)) % CYCLE_FRAMES)
                    spin(wheel, angle)
                    bpy.context.view_layer.update()
                    scene.render.filepath = os.path.join(out_dir, name,
                                                         f"f_{index:04d}")
                    bpy.ops.render.opengl(write_still=True, view_context=True)
                written[name] = len(shots)
    finally:
        space.shading.type, space.overlay.show_overlays = previous[0], previous[1]
        if previous[2] is not None:
            anim_climb._assign_action(arm, previous[2].name)
        scene.frame_set(0)
        _drop(scaffold)

    written["frames"] = len(shots)
    written["seconds"] = round(len(shots) / FPS, 3)
    return written
