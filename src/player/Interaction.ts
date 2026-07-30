/**
 * Interaction focus: what the player is looking at and can use with `F`.
 *
 * **No raycast.** A ray against the ship's mesh would look stricter, but it
 * would be expensive per frame and give a worse result: it would demand aiming
 * at the right pixel of the helm, when what's wanted is "I'm close to the helm
 * and facing it". Proximity, level and view angle are what Sea of Thieves
 * delivers in practice — it forgives the aim and never offers a part that is
 * behind you.
 *
 * Everything here works in the ship's local coordinates, in the same frame the
 * `PlayerController` already lives in: no matrix conversion and no dependence on
 * the model's interpolated pose.
 */

import * as THREE from 'three';
import { InputBit, held as isHeld, pressed, type InputFrame } from '../core/InputFrame';
import { clamp, clamp01 } from '../core/MathUtils';
import type { Ship } from '../ship/Ship';
import { boardingLadderForSide, boardingLadderPoint } from '../ship/BoardingLadder';
import { DECK_Y, STATIONS, tToZ } from '../ship/ShipDimensions';
import {
  BILGE_PUMP,
  BILGE_PUMP_HANDLE_Y,
  CROW_NEST,
  MAST_LADDER,
  WHEEL_Y,
} from '../ship/ShipParts';
import type { Breach } from '../ship/ShipDamage';
import type { PlayerController } from './PlayerController';

/** Something aboard that responds to `F`. */
export interface Interactable {
  readonly id: string;
  /**
   * Focus point, in the ship's local coordinates.
   *
   * `readonly` is the reference, not the contents: parts that move rewrite the
   * vector in `refresh()`. Swapping the object would break the identity
   * comparison that resets `holdTime` when the target changes.
   */
  readonly local: THREE.Vector3;
  /** Maximum distance from the eye to the point, in meters. */
  readonly range: number;
  /**
   * Which level the part sits on. Focus does not go through the floor.
   *
   * Without this, someone in the hold under the quarterdeck sees the helm 1.5 m
   * from the eye — short distance, wide cone, prompt lit — and takes the rudder
   * through the planks, from inside the hull. The same goes for the cannons and
   * the capstan, all within reach of anyone walking underneath them.
   *
   * It's the cheap check that replaces the raycast this file makes a point of
   * not having: the ship has only two levels, and no part belongs to both.
   *
   * **The sea is the third**, and it exists for the same reason as the other
   * two, with the sign flipped: someone floating at the stern is less than two
   * meters from the helm, with the cone wide and the prompt lit — and would take
   * the rudder from inside the ocean. A level of its own makes that whole class
   * of defect impossible, instead of demanding a guard on every part of the ship.
   */
  readonly level: 'deck' | 'hold' | 'water';
  /**
   * The prompt text right now. `null` hides the part — that's how the cannon
   * drops off the list when the player is already at another cannon.
   */
  /**
   * Repositions the target before the focus test, for parts with no fixed place.
   * It's what lets the breaches be a single entry in the list instead of one per
   * hole: every frame it moves to the breach nearest the player.
   */
  refresh?(player: PlayerController): void;
  label(): string | null;
  /**
   * While this returns `true`, the part **holds the focus** — neither the view
   * cone nor the distance takes the prompt away from it.
   *
   * It exists because of the capstan, the only part of the ship that turns into
   * a mode: someone walking the bars leaves their cone within the first quarter
   * turn, and recalculating the focus in there would kill the prompt right in
   * the hands of the player who needs it to let the part go. It's an explicit
   * contract, not the side effect of a held button.
   */
  locks?(): boolean;
  /** Tap: fires once per press. */
  press?(): void;
  /** Hold: called every frame while `F` is held down. */
  hold?(dt: number): void;
  /**
   * Progress from 0 to 1 for the prompt bar, or `null` when nothing is under
   * way. It's the part's state, not the key-hold time: the capstan shows how
   * much of the cable is already up, and releasing `F` freezes the bar where it
   * was instead of resetting it.
   */
  progress?(): number | null;
}

/**
 * Half-width of the focus cone in the horizontal, in radians (40°).
 *
 * The limit is geometric, not taste: with a 62° vertical FOV at 16:9 the
 * horizontal half-screen is ~47°. Going past that lights the prompt of a part
 * that isn't drawn anywhere — at spawn, the starboard cannon sits 53° off center
 * and it painted "Man the starboard cannon" over empty sea. 40° fits on screen at
 * any reasonable aspect ratio and still leaves 80° of tolerance.
 */
const FOCUS_AZIMUTH = 0.7;
/**
 * And in the vertical, far looser (65°).
 *
 * Not gratuitous asymmetry: the screen is wider than it is tall, and the head
 * turns far more easily than it looks down. The capstan and the hatch are at
 * waist and floor height — standing a step away from them, the target falls 48°
 * and 57° below the gaze with nobody aiming wrong. Charging 40° here would kill
 * the prompt for exactly the player who already reached the part.
 */
const FOCUS_ELEVATION = 1.13;

/**
 * How far the hand reaches a breach, in meters.
 *
 * Looser than the reach of the other parts: a breach can open flush with the
 * keel, in a corner you can't get to standing up, and charging 2.2 m there would
 * leave the hole impossible to patch for no reason at all.
 */
const REPAIR_REACH = 3;

const _toItem = new THREE.Vector3();
const _eyeSpace = new THREE.Vector3();
const _inverseEye = new THREE.Quaternion();
const _aim = new THREE.Vector3();
const _toBreach = new THREE.Vector3();

export class Interaction {
  readonly items: Interactable[] = [];

  /** What is in focus this frame, or `null`. */
  focus: Interactable | null = null;
  /** Seconds `F` has been held on the current focus. */
  holdTime = 0;

  /**
   * `true` while the player is actually nailing a plank over a breach.
   *
   * Not the same as "the focus is a breach": looking at the hole without pressing
   * anything puts wood in nobody's hands. What reads this is the player's body,
   * to know when to switch the pose and when to make the plank appear.
   *
   * It lives here because this is where the information exists. The
   * `PlayerController` doesn't know about breaches, and `ShipDamage` doesn't know
   * about a held button — only this class sees both in the same frame.
   */
  patching = false;

  add(item: Interactable): void {
    this.items.push(item);
  }

  /**
   * One step of contextual focus.
   *
   * Runs on the fixed step along with the deckhand, not on the frame. What that
   * fixes right away, even with no network: `hold(dt)` fed `ship.patchBreach` the
   * **frame**'s `dt`, so nailing a plank was faster at 144 fps than at 30.
   */
  update(dt: number, frame: InputFrame, player: PlayerController): void {
    // At a station, the only command that matters is leaving it — and that's the
    // main loop's job, not the interaction focus's.
    if (player.station !== 'deck' || player.onLadder) {
      this.focus = null;
      this.holdTime = 0;
      this.patching = false;
      return;
    }

    const previous = this.focus;
    // **Holding pins the focus.** Without this, starting an action and turning
    // the head interrupts it.
    //
    // The target still has to exist (`label()`), and it's that clause that makes
    // the repair behave: on the frame the breach closes, it drops off the list,
    // the label goes `null` and the focus is recalculated on the spot — without
    // releasing the button, the next plank already latches onto the next hole.
    // Before, the target stayed frozen on a breach that no longer existed, and
    // the player watched the counter go past 100% with the hole still spraying
    // right next to it.
    //
    // A part in mode (`locks`) takes precedence over both: it depends neither on
    // a held button nor on being in the cone.
    const locked = this.lockedItem();
    const held = isHeld(frame, InputBit.Interact) && previous !== null && previous.label() !== null;
    this.focus = locked ?? (held ? previous : this.findFocus(player));

    // Switching parts resets the count: you can't start turning the capstan on
    // one target and finish on another.
    if (this.focus !== previous) this.holdTime = 0;
    if (!this.focus) {
      this.patching = false;
      return;
    }

    if (pressed(frame, InputBit.Interact)) this.focus.press?.();
    if (isHeld(frame, InputBit.Interact)) {
      this.holdTime += dt;
      this.focus.hold?.(dt);
    } else {
      this.holdTime = 0;
    }

    // After the `hold`, not before: the frame the breach closes is exactly the
    // frame `hold` takes it off the list, and that's when the plank has to leave
    // the hand to reappear nailed to the hull.
    this.patching = this.focus.id === 'breach'
      && isHeld(frame, InputBit.Interact)
      && this.focus.label() !== null;
  }

  /** The prompt label to draw, or `null` when there is no focus. */
  get prompt(): string | null {
    return this.focus?.label() ?? null;
  }

  clear(): void {
    this.items.length = 0;
    this.focus = null;
    this.holdTime = 0;
  }

  /**
   * The part holding the focus by being a mode, if any.
   *
   * Sweeps the list instead of looking only at the previous frame's focus: that
   * way the mode holds up even after a pause, a menu or anything else that
   * cleared the focus along the way.
   */
  private lockedItem(): Interactable | null {
    for (const item of this.items) {
      if (item.locks?.()) return item;
    }
    return null;
  }

  private findFocus(player: PlayerController): Interactable | null {
    const level = player.inWater ? 'water' : player.inHold ? 'hold' : 'deck';
    _inverseEye.copy(player.eyeQuaternion).invert();

    let best: Interactable | null = null;
    let bestScore = 0;

    for (const item of this.items) {
      if (item.level !== level) continue;
      item.refresh?.(player);
      if (!item.label()) continue;

      _toItem.subVectors(item.local, player.eyeLocal);
      const distance = _toItem.length();
      if (distance > item.range || distance < 1e-4) continue;

      // In the eye's frame the direction becomes two separate angles, and that's
      // what lets the horizontal and the vertical be held to different limits.
      // Forward is −Z, as everywhere else in the project.
      _eyeSpace.copy(_toItem).applyQuaternion(_inverseEye);
      const azimuth = Math.atan2(_eyeSpace.x, -_eyeSpace.z);
      const elevation = Math.atan2(_eyeSpace.y, Math.hypot(_eyeSpace.x, _eyeSpace.z));

      // Angular distance normalized by both limits: 1 is the edge of the ellipse.
      // Anything behind drops out on its own — the azimuth goes past 90°.
      const offAxis = Math.hypot(azimuth / FOCUS_AZIMUTH, elevation / FOCUS_ELEVATION);
      if (offAxis > 1) continue;

      // Aim weighs more than distance: between the helm and the capstan almost on
      // top of each other, the one the player turned their head toward wins.
      const score = (1 - offAxis) / (1 + distance * 0.25);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    return best;
  }
}

/**
 * Builds the Sloop's interactive parts.
 *
 * It lives here, and not in `main.ts`, because each one depends on knowing
 * *where* the part was drawn — and that's the same math `ShipBuilder` did. They
 * all read from `ShipDimensions`, so moving a station moves the model and the
 * prompt together.
 */
export function createShipInteractables(ship: Ship, player: PlayerController): Interactable[] {
  const items: Interactable[] = [
    {
      id: 'helm',
      local: new THREE.Vector3(0, WHEEL_Y, tToZ(STATIONS.helm)),
      range: 2.4,
      level: 'deck',
      label: () => 'Take the helm',
      press: () => player.takeHelm(),
    },
    {
      id: 'capstan',
      local: new THREE.Vector3(0, DECK_Y + 0.45, tToZ(STATIONS.capstan)),
      // A little **shorter** than the mode's reach, not longer: the focus point
      // sits 1.21 m off the standing eye, so 2.4 m from eye to target is 2.07 m
      // in the deck plane — inside the 2.1 m `pushCapstan` requires. That way the
      // prompt never lights somewhere the tap won't catch the bars.
      range: 2.4,
      level: 'deck',
      label: () => {
        const anchor = ship.anchor;
        if (anchor.state === 'stowed') return 'Drop anchor';
        if (anchor.state === 'dropping') return 'Dropping anchor…';
        // Says what to do, not what is happening: whoever takes the capstan with
        // the anchor on the bottom has to find out they need to **walk forward**,
        // and this is the only chance to say so without a tutorial screen.
        const raised = Math.round(clamp01(anchor.raised) * 100);
        return player.atCapstan
          ? `Walk forward to heave — ${raised}%`
          : `Take the capstan — ${raised}%`;
      },
      // Dropping is a tap, weighing is a **mode**. The asymmetry is the game's,
      // and it comes from `Anchor`: the latch lets go by itself, the capstan
      // needs muscle — and here muscle is the player actually walking laps.
      //
      // The same button enters and leaves. This runs **after** the
      // `PlayerController` in the frame (see `Match.update`), which is what
      // guarantees the entry tap isn't read as an exit in the same frame.
      press: () => {
        if (player.atCapstan) {
          player.leaveCapstan();
          return;
        }
        const anchor = ship.anchor;
        if (anchor.state === 'stowed') {
          anchor.drop(ship.body);
          return;
        }
        // While it's dropping no bar responds — `Anchor.heave` discards the
        // effort while the cable runs out, and entering the mode there would walk
        // laps for nothing.
        if (anchor.state === 'set' || anchor.state === 'raising') player.enterCapstan();
      },
      // There is no `hold`: what adds up the laps is the `PlayerController`
      // itself, the only one that knows how far the deckhand walked. See
      // `pushCapstan`.
      locks: () => player.atCapstan,
      progress: () => (ship.anchor.isDeployed ? clamp01(ship.anchor.raised) : null),
    },
    // The hold's ladder is **not** on this list, and that's deliberate: it became
    // a sloped flight of stairs, which is floor. There's nothing to interact with
    // on a floor — you walk on it. See `stairSurfaceY`.
    {
      id: 'pump',
      local: new THREE.Vector3(BILGE_PUMP.x - 0.5, BILGE_PUMP_HANDLE_Y, BILGE_PUMP.z + 0.1),
      range: 2.3,
      level: 'hold',
      // Only shows up with water in the hold: a dry pump has nothing to do, and a
      // prompt lit for nothing would compete with the stairs' one, right beside
      // it. "Hold to pump — hold at 45%" had the same word in two senses in the
      // same sentence: the verb for holding the button and the hold that drains.
      // Whoever read it took 45% for the pumping progress, kept holding waiting to
      // reach 100 and concluded the pump did nothing.
      label: () => {
        const flood = ship.damage.floodFraction;
        if (flood < 0.005) return null;
        return `Work the pump — bilge at ${Math.round(flood * 100)}%`;
      },
      hold: () => {
        ship.controls.pumping = true;
      },
      // The bar shows how much is **left** to drain, so it fills as the water
      // goes down. A bar that runs backward while you work would be the wrong
      // reading of the effort.
      progress: () =>
        ship.damage.floodFraction > 0.005 ? clamp01(1 - ship.damage.floodFraction) : null,
    },
  ];

  // The mast ladder: a mode you enter and leave with the **same key**, and that's
  // what separates it from the hold's flight of stairs just above.
  //
  // It used to be grabbed by brushing against it walking forward, and that cost
  // the two things a mode can't cost. It climbed with nobody asking — the mast
  // sits in the middle of the walkway and anyone going around it scrapes the
  // rungs. And there was no way out at the top: climbing down took the same
  // gesture as climbing up, so whoever reached the crow's nest was stuck up there
  // with the sea for a frame.
  //
  // The target chases eye height because the same item serves both ends. Pinned
  // at the foot of the ladder, the prompt would disappear right at the topsail
  // platform, which is where it's needed most.
  const ladderItem: Interactable = {
    id: 'mast-ladder',
    local: new THREE.Vector3(0, DECK_Y + 1, MAST_LADDER.z),
    range: 2.4,
    level: 'deck',
    refresh: () => {
      // At eye height, not foot height: the target has to land near the line of
      // sight at both ends, otherwise up on the topsail platform it sits a meter
      // below the gaze and leaves the cone of exactly the player who wants to
      // climb down.
      ladderItem.local.y = clamp(
        player.eyeLocal.y,
        MAST_LADDER.bottomY + 0.5,
        CROW_NEST.y + 1.4,
      );
    },
    label: () => {
      if (!player.canGrabMastLadder()) return null;
      // The same question the controller asks to know which floor the player is
      // on — not a similar height written out again here.
      return player.onCrowNest() ? 'Climb down to the deck' : 'Climb to the crow’s nest';
    },
    press: () => player.grabMastLadder(),
  };
  items.push(ladderItem);

  // The two parts of the sea. They live on the `'water'` level, which already
  // hides them from anyone aboard and hides the whole ship from anyone in the
  // water — see `Interactable.level`.
  //
  // The boarding ladder is **one entry that changes sides**, not two: someone in
  // the water can only reach the one on their own side of the hull, so the second
  // could never be in focus. Same economy as the breaches, just below.
  const ladderPoint = new THREE.Vector3();
  const boardingItem: Interactable = {
    id: 'boarding-ladder',
    local: ladderPoint,
    // From the floating eye's position to the rung: ~0.9 m in the vertical (the
    // eye sits 22 cm above the surface, the target 40 cm below it) plus the 1.5 m
    // reach in the water plane. 2.4 m covers the diagonal with room to spare, and
    // it's still the standard reach of the ship's parts.
    range: 2.4,
    level: 'water',
    refresh: (p) => {
      const spec = boardingLadderForSide(p.local.x);
      // The target is the rung just **above** the waterline, not the deepest one:
      // that's the one a swimmer looks at, and the one drawn out of the sea.
      boardingLadderPoint(spec, 0.4, ladderPoint);
    },
    // What decides whether it can be grabbed is the controller, which knows the
    // hand's reach and where the body would end up hanging. Here it's only asked.
    label: () => (player.reachableBoardingLadder() ? 'Climb aboard' : null),
    press: () => {
      const spec = player.reachableBoardingLadder();
      if (spec) player.grabBoardingLadder(spec);
    },
  };
  items.push(boardingItem);

  // The rescue. It's the only part of the game that **isn't a part**: there's
  // nowhere to point, because the decision doesn't live anywhere in the world —
  // the ship is far away and that's exactly why help is being called for.
  //
  // Nicolas asked for "a button to click"; the game runs with the pointer locked,
  // and an on-screen button there would mean unlocking the mouse mid-match. This
  // is the translation of it: the same action prompt as everything else, with the
  // same key.
  const rescueItem: Interactable = {
    id: 'rescue',
    local: new THREE.Vector3(),
    range: 2,
    level: 'water',
    refresh: (p) => {
      // The target follows the gaze, a meter in front of the eye: that way it's
      // always inside the cone and inside the range, and the prompt appears for
      // **having been in the water long enough**, which is the only condition
      // there is. Pinning it to the hull would make the rescue depend on the
      // swimmer looking at a ship that has already vanished over the horizon.
      _aim.set(0, 0, -1).applyQuaternion(p.eyeQuaternion);
      rescueItem.local.copy(p.eyeLocal).addScaledVector(_aim, 1);
    },
    // **The ladder beats the rescue**, and it isn't a matter of score: climbing up
    // by yourself is always better than the black screen, and a target glued to
    // the center of the view would beat the ladder's in any aim contest. It
    // disappears while there's a rung within reach.
    label: () =>
      player.canRequestRescue() && !player.reachableBoardingLadder()
        ? 'Signal for a rope'
        : null,
    press: () => player.requestRescue(),
  };
  items.push(rescueItem);

  // Breaches: a single entry that moves to the nearest hole. There are up to 24
  // at once and they appear in unpredictable positions — registering one item per
  // breach would mean touching the list in the middle of combat.
  let targetBreach: Breach | null = null;

  /**
   * The target, if it's still a real breach.
   *
   * The target is a reference held in a closure, and `refresh` only runs when the
   * focus is recalculated — that is, **never** while the button is held. A breach
   * patched in the middle of a hold stayed in here, alive and taking planks,
   * because nothing told this variable it had left the list. The membership check
   * is that notice, and it's cheap: 24 reference comparisons in the worst case.
   */
  const currentBreach = (): Breach | null => {
    if (targetBreach && !ship.damage.breaches.includes(targetBreach)) targetBreach = null;
    return targetBreach;
  };

  const breachItem: Interactable = {
    id: 'breach',
    local: new THREE.Vector3(),
    range: REPAIR_REACH,
    level: 'hold',
    refresh: () => {
      targetBreach = aimedBreach(ship, player);
      if (targetBreach) breachItem.local.copy(targetBreach.local);
    },
    label: () => {
      const breach = currentBreach();
      if (!breach) return null;
      // An empty locker still shows the breach, and deliberately so: making the
      // notice disappear would leave the player thinking they are too far away or
      // aiming wrong. What they need to know is that the hole is there and that
      // there's no more wood for it — from then on the work is at the pump.
      if (!ship.hasPlanks) return 'No planks left — man the pump';
      const done = Math.round(clamp01(breach.repair) * 100);
      const left = `${ship.planks} in the locker`;
      return done > 0 ? `Hold to patch — ${done}% · ${left}` : `Hold to patch the hole · ${left}`;
    },
    hold: (dt) => {
      const breach = currentBreach();
      if (!breach) return;
      // The return value **matters**: it's what says the hole closed. Ignoring it
      // was what kept the player nailing planks into thin air past 100%.
      if (ship.patchBreach(breach, dt)) targetBreach = null;
    },
    progress: () => {
      const breach = currentBreach();
      return breach && breach.repair > 0 ? clamp01(breach.repair) : null;
    },
  };
  items.push(breachItem);

  ship.cannons.forEach((cannon, index) => {
    const local = new THREE.Vector3();
    items.push({
      id: cannon.side > 0 ? 'cannon-starboard' : 'cannon-port',
      // The focus point is the breech, not the muzzle: it's where the gun is
      // worked from, and it's what keeps the starboard cannon from stealing the
      // focus of someone at port looking through the ship.
      local: cannon.getPivotLocal(local),
      range: 2.5,
      level: 'deck',
      label: () => (cannon.side > 0 ? 'Man the starboard cannon' : 'Man the port cannon'),
      press: () => player.mountCannon(index),
    });
  });

  return items;
}

/**
 * The breach the player is **looking at**, not simply the nearest one.
 *
 * `ShipDamage.findNear` answers by pure distance, which is the right thing for
 * deciding whether a fresh cannonball widens an existing hole — but it's the
 * wrong question here. A broadside opens several holes in the same plank, and
 * `MERGE_DISTANCE` is only 42 cm: with two breaches within the hand's reach, the
 * player aimed at one and the code nailed the plank over the other, at their feet.
 * The bar filled, one hole closed, and the one they were looking at kept spraying
 * — exactly the reading of "I got to 100% and the breach didn't go away". With the
 * merge tightened up this got **more** frequent, not less: more breaches fit in
 * the same handspan of hull side.
 *
 * The score is the same as the interaction focus's: aim weighs more than distance.
 */
function aimedBreach(ship: Ship, player: PlayerController): Breach | null {
  // Forward is −Z, as everywhere else in the project.
  _aim.set(0, 0, -1).applyQuaternion(player.eyeQuaternion);

  let best: Breach | null = null;
  let bestScore = 0;

  for (const breach of ship.damage.breaches) {
    _toBreach.subVectors(breach.local, player.eyeLocal);
    const distance = _toBreach.length();
    if (distance > REPAIR_REACH || distance < 1e-4) continue;

    // Cosine of the angle between the aim and the breach. Anything behind drops
    // out on its own, with no need for a second test.
    const alignment = _toBreach.dot(_aim) / distance;
    if (alignment <= 0) continue;

    const score = alignment / (1 + distance * 0.25);
    if (score > bestScore) {
      bestScore = score;
      best = breach;
    }
  }

  return best;
}
