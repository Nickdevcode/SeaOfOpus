/**
 * The combat HUD: compass, enemy marker, hold and the guns' state.
 *
 * Two engineering decisions shape the file.
 *
 * **1. The DOM is only touched when the content changes.** This HUD runs every frame, and
 * writing `textContent` at 144 Hz forces the browser to redo the text layout even when
 * the number is the same. Each field keeps the last value it wrote and bails out if
 * nothing changed. What changes every frame by nature — the compass's scroll and the
 * marker's position — uses **only `transform`**, which the compositor resolves without
 * touching layout.
 *
 * **2. The compass is one long strip that slides, not repositioned ticks.** The ticks are
 * created once, covering 720° at fixed positions, and the heading comes in as a single
 * `translateX`. The alternative — recomputing the `left` of 24 ticks per frame — is 24
 * layout writes per frame for the same visual result. The 720° (two turns) exist so the
 * window always falls in the middle of the strip and neither edge is left without ticks
 * when crossing North.
 */

import * as THREE from 'three';
import { RAD, clamp01 } from '../core/MathUtils';
import { downwindHeading } from '../ship/SailSim';
import type { Ship } from '../ship/Ship';
import type { WaveField } from '../world/WaveField';
import '../styles/hud.css';

/** Pixels per degree on the compass strip: ~90° visible in the 34rem window. */
const PIXELS_PER_DEGREE = 6;
/** Step between minor ticks, in degrees. */
const TICK_STEP = 15;
/** Clearance from the screen's edge for the off-screen arrow, in pixels. */
const EDGE_MARGIN = 46;

/** The flooding at which the well warns, and the one at which it shouts. */
const WARN_FLOOD = 0.25;
const CRITICAL_FLOOD = 0.5;

const CARDINALS: Record<number, string> = {
  0: 'N',
  45: 'NE',
  90: 'E',
  135: 'SE',
  180: 'S',
  225: 'SW',
  270: 'W',
  315: 'NW',
};

const _worldPoint = new THREE.Vector3();
const _projected = new THREE.Vector3();

/** A text field that only writes to the DOM when the value changes. */
class TextField {
  private last = '\0';

  constructor(readonly element: HTMLElement) {}

  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.element.textContent = value;
  }
}

function div(className: string, parent?: HTMLElement): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  parent?.appendChild(element);
  return element;
}

export class CombatHud {
  private readonly root: HTMLDivElement;

  private readonly compassStrip: HTMLDivElement;
  private readonly windMark: HTMLDivElement;
  private readonly heading: TextField;

  private readonly target: HTMLDivElement;
  private readonly targetMark: HTMLDivElement;
  private readonly targetRange: TextField;

  private readonly bilge: HTMLDivElement;
  private readonly bilgeWater: HTMLDivElement;
  private readonly bilgeValue: TextField;

  private readonly pieces: readonly { row: HTMLDivElement; label: TextField }[];
  private readonly magazine: TextField;

  private readonly drown: HTMLDivElement;
  private readonly drownWord: TextField;

  private readonly foeState: HTMLDivElement;
  private readonly foeStateText: TextField;

  /** The well's last state class, so `className` is not rewritten every frame. */
  private lastBilgeClass = '';
  private lastDrownOpacity = -1;

  constructor(parent: HTMLElement) {
    this.root = div('hud');
    this.root.hidden = true;

    // --- compass ---
    const compass = div('compass', this.root);
    this.compassStrip = div('compass__strip', compass);
    this.buildTicks();

    // The arrow points to the **downwind** heading, not to where the wind comes from.
    // That is the actionable information: it is the sloop's fastest heading, and it is
    // where you run when you are losing.
    this.windMark = div('compass__wind', this.compassStrip);
    this.windMark.textContent = '▼';

    div('compass__lubber', this.root);
    this.heading = new TextField(div('compass__heading', this.root));

    this.foeState = div('foe-state', this.root);
    this.foeStateText = new TextField(this.foeState);

    // --- enemy marker ---
    this.target = div('target', this.root);
    this.target.hidden = true;
    this.targetMark = div('target__mark', this.target);
    this.targetRange = new TextField(div('target__range', this.target));

    // --- the hold's well ---
    this.bilge = div('bilge', this.root);
    const bilgeLabel = div('bilge__label', this.bilge);
    const caption = document.createElement('span');
    caption.textContent = 'Hold';
    bilgeLabel.appendChild(caption);
    this.bilgeValue = new TextField(
      bilgeLabel.appendChild(document.createElement('span')),
    );
    this.bilgeValue.element.className = 'bilge__value';
    const well = div('bilge__well', this.bilge);
    this.bilgeWater = div('bilge__water', well);

    // --- guns and magazine ---
    // In a single column, anchored above the control hints: see `.crew-status`.
    const crew = div('crew-status', this.root);
    const pieces = div('pieces', crew);
    this.pieces = ['Starboard', 'Port'].map((name) => {
      const row = div('piece', pieces);
      div('piece__pip', row);
      const text = document.createElement('span');
      row.appendChild(text);
      const label = new TextField(text);
      label.set(name);
      return { row, label };
    });

    const magazine = div('magazine', crew);
    const magazineCaption = document.createElement('span');
    magazineCaption.textContent = 'Shot ';
    magazine.appendChild(magazineCaption);
    const magazineCount = document.createElement('span');
    magazineCount.className = 'magazine__count';
    magazine.appendChild(magazineCount);
    this.magazine = new TextField(magazineCount);

    // --- aviso de afundamento ---
    this.drown = div('drown', this.root);
    this.drownWord = new TextField(div('drown__word', this.drown));

    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  dispose(): void {
    this.root.remove();
  }

  /**
   * One HUD frame.
   *
   * @param camera needed to project the enemy onto the screen.
   */
  /**
   * @param foeLabel how the opponent is announced: the machine captain's intent, or the
   *   nickname of whoever is on the other side. The HUD does not ask which of the two it
   *   is — whoever knows is whoever set the match up, and passing the label ready-made is
   *   what makes this screen work the same in both modes.
   */
  update(
    ship: Ship,
    enemy: Ship,
    foeLabel: string,
    camera: THREE.PerspectiveCamera,
    waves: WaveField,
  ): void {
    if (this.root.hidden) return;

    this.updateCompass(ship, waves);
    this.updateTarget(enemy, camera);
    this.updateBilge(ship);
    this.updatePieces(ship);
    this.updateFoe(enemy, foeLabel);
  }

  // -- compass -----------------------------------------------------------------

  /** Creates the ticks once, covering two turns. See the note at the top. */
  private buildTicks(): void {
    for (let degrees = 0; degrees <= 720; degrees += TICK_STEP) {
      const cardinal = CARDINALS[degrees % 360];
      const tick = div(
        cardinal ? 'compass__tick compass__tick--cardinal' : 'compass__tick',
        this.compassStrip,
      );
      tick.style.left = `${degrees * PIXELS_PER_DEGREE}px`;
      if (cardinal) tick.textContent = cardinal;
    }
  }

  private updateCompass(ship: Ship, waves: WaveField): void {
    // The game's heading is 0 at −Z and grows to port; the player's compass has to grow
    // clockwise, like any compass. Hence the negation.
    const degrees = (((-ship.heading * RAD) % 360) + 360) % 360;

    // Center the window in the middle of the strip (the middle turn, +360°), so both
    // edges always have ticks even when crossing North.
    const width = this.compassStrip.parentElement?.clientWidth ?? 0;
    const offset = width / 2 - (degrees + 360) * PIXELS_PER_DEGREE;
    this.compassStrip.style.transform = `translateX(${offset.toFixed(1)}px)`;

    const downwind = (((-downwindHeading(waves) * RAD) % 360) + 360) % 360;
    this.windMark.style.left = `${(downwind + 360) * PIXELS_PER_DEGREE}px`;

    this.heading.set(`${degrees.toFixed(0).padStart(3, '0')}°`);
  }

  // -- enemy marker ------------------------------------------------------------

  private updateTarget(enemy: Ship, camera: THREE.PerspectiveCamera): void {
    if (enemy.damage.isSunk) {
      this.target.hidden = true;
      return;
    }

    // Aim at the masthead? No: at the middle of the hull. The mast is 12 m and up close
    // the marker would climb far above the ship, pointing at empty sky.
    enemy.body.localToWorld(_worldPoint.set(0, 2, 0), _worldPoint);
    const distance = camera.position.distanceTo(_worldPoint);

    _projected.copy(_worldPoint).project(camera);

    const width = window.innerWidth;
    const height = window.innerHeight;
    // `z > 1` is behind the near plane, and in that case the projection comes out
    // mirrored — the sign has to be flipped for the arrow to point backward and not
    // forward.
    const behind = _projected.z > 1;
    const ndcX = behind ? -_projected.x : _projected.x;
    const ndcY = behind ? -_projected.y : _projected.y;

    const onScreen = !behind && Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1;
    this.target.hidden = false;
    this.targetRange.set(`${distance.toFixed(0)} m`);

    if (onScreen) {
      if (this.target.classList.contains('target--offscreen')) {
        this.target.classList.remove('target--offscreen');
      }
      const x = (ndcX * 0.5 + 0.5) * width;
      const y = (-ndcY * 0.5 + 0.5) * height;
      this.target.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      return;
    }

    // Off screen: it sticks to the edge in the right direction and becomes an arrow.
    if (!this.target.classList.contains('target--offscreen')) {
      this.target.classList.add('target--offscreen');
    }

    const halfWidth = width / 2 - EDGE_MARGIN;
    const halfHeight = height / 2 - EDGE_MARGIN;
    const dirX = ndcX;
    // The screen grows downward and the NDC upward.
    const dirY = -ndcY;

    // Scale the vector until it touches the box's first edge. The larger of the two
    // quotients is the axis that overflows first.
    const scale = Math.max(
      Math.abs(dirX) / (halfWidth || 1),
      Math.abs(dirY) / (halfHeight || 1),
    );
    const factor = scale > 1e-6 ? 1 / scale : 0;
    const x = width / 2 + dirX * factor;
    const y = height / 2 + dirY * factor;

    this.target.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
    // The CSS arrow points down at rest, so the angle's zero is +Y.
    this.targetMark.style.setProperty('--angle', `${Math.atan2(dirX, dirY).toFixed(3)}rad`);
  }

  // -- hold --------------------------------------------------------------------

  private updateBilge(ship: Ship): void {
    const flood = ship.damage.floodFraction;

    this.bilgeWater.style.transform = `scaleY(${flood.toFixed(3)})`;
    this.bilgeValue.set(`${(flood * 100).toFixed(0)}%`);

    const className =
      flood >= CRITICAL_FLOOD ? 'bilge bilge--critical'
      : flood >= WARN_FLOOD ? 'bilge bilge--warn'
      : 'bilge';
    if (className !== this.lastBilgeClass) {
      this.bilge.className = className;
      this.lastBilgeClass = className;
    }

    // The vignette only starts showing at the warning, and goes all the way at the
    // critical mark: before that it would be anxiety with no information.
    const alarm = ship.damage.isSinking
      ? 1
      : clamp01((flood - WARN_FLOOD) / (CRITICAL_FLOOD * 1.6 - WARN_FLOOD));
    // Rounded to two places: without it, it is a style write per frame for a difference
    // nobody sees.
    const rounded = Math.round(alarm * 100) / 100;
    if (rounded !== this.lastDrownOpacity) {
      this.drown.style.opacity = `${rounded}`;
      this.lastDrownOpacity = rounded;
    }
    this.drownWord.set(
      ship.damage.isSinking ? 'The sloop is going down'
      : rounded > 0.25 ? 'Water in the hold — get below and patch it'
      : '',
    );
  }

  // -- guns --------------------------------------------------------------------

  private updatePieces(ship: Ship): void {
    for (let i = 0; i < this.pieces.length; i++) {
      const entry = this.pieces[i]!;
      const cannon = ship.cannons[i];
      const state = cannon?.state ?? 'empty';
      const className =
        state === 'loaded' ? 'piece piece--loaded'
        : state === 'loading' ? 'piece piece--loading'
        : 'piece';
      if (entry.row.className !== className) entry.row.className = className;
    }

    this.magazine.set(`${ship.cannonballs}`);
  }

  // -- enemy -------------------------------------------------------------------

  private updateFoe(enemy: Ship, foeLabel: string): void {
    if (enemy.damage.isSunk) {
      this.foeState.hidden = true;
      return;
    }
    this.foeState.hidden = false;

    // It shows the enemy's intent **and** their hold: the two together are the duel's
    // scoreboard. Seeing the enemy on "Patching breaches" with the hold at 40% is the
    // reading that you are winning, and it needs no health bar at all.
    const flood = enemy.damage.floodFraction;
    const suffix = flood > 0.01 ? ` · hold ${(flood * 100).toFixed(0)}%` : '';
    this.foeStateText.set(`${foeLabel}${suffix}`);
  }
}
