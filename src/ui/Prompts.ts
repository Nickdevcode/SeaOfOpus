/**
 * Contextual prompts: what you can do right now, and with which key.
 *
 * It is HTML over the canvas, not 3D text. UI text drawn in the world costs a mesh and an
 * atlas per phrase and still comes out jagged; the DOM already handles font, subpixel and
 * screen scale for free, and the cost is zero while nothing changes — hence the care to
 * only write to the DOM when the content is different.
 *
 * The labels come out of `ACTION_LABELS`, the same table the remapping uses, and switch
 * to the controller's buttons the instant the player **touches** the controller — not
 * when it is plugged in (see `Input.activeDevice`). A key renamed there shows up here on
 * its own.
 */

import type { Action } from '../core/Input';
import { ACTION_LABELS, type Input } from '../core/Input';
import type { Interaction } from '../player/Interaction';
import type { PlayerController } from '../player/PlayerController';
import type { Ship } from '../ship/Ship';
import '../styles/prompts.css';

/**
 * One control hint: the key and what it does.
 *
 * Most of them come out of `ACTION_LABELS` through `action`. The ones that do not are the
 * movement axes — there is no "action" called walking forward, there is an axis —, and
 * that is what the `key`/`padKey` pair is for: without the second, the panel went on
 * asking for `W / S` from someone with both hands on the controller.
 */
interface Hint {
  action: Action | null;
  key?: string;
  /** The equivalent label on the controller. Without it, `key` holds for both. */
  padKey?: string;
  text: string;
}

export class Prompts {
  private readonly root: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private readonly promptKey: HTMLSpanElement;
  private readonly promptLabel: HTMLSpanElement;
  private readonly promptBar: HTMLDivElement;
  private readonly promptFill: HTMLDivElement;
  private readonly hints: HTMLDivElement;
  private readonly reticle: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly resume: HTMLDivElement;

  private lastLabel = '';
  private lastKey = '';
  private lastHints = '';
  private lastStatus = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'prompts';

    this.reticle = document.createElement('div');
    this.reticle.className = 'prompts__reticle';
    this.reticle.hidden = true;

    this.prompt = document.createElement('div');
    this.prompt.className = 'prompts__action';
    this.prompt.hidden = true;

    this.promptKey = document.createElement('span');
    this.promptKey.className = 'prompts__key';
    this.promptLabel = document.createElement('span');
    this.promptLabel.className = 'prompts__label';
    this.promptBar = document.createElement('div');
    this.promptBar.className = 'prompts__bar';
    this.promptBar.hidden = true;
    this.promptFill = document.createElement('div');
    this.promptFill.className = 'prompts__fill';
    this.promptBar.appendChild(this.promptFill);
    this.prompt.append(this.promptKey, this.promptLabel, this.promptBar);

    this.status = document.createElement('div');
    this.status.className = 'prompts__status';
    this.status.hidden = true;

    this.hints = document.createElement('div');
    this.hints.className = 'prompts__hints';

    this.resume = document.createElement('div');
    this.resume.className = 'prompts__resume';
    this.resume.textContent = 'Click to look around';
    this.resume.hidden = true;

    this.root.append(this.reticle, this.status, this.prompt, this.hints, this.resume);
    parent.appendChild(this.root);
  }

  update(input: Input, interaction: Interaction, player: PlayerController, ship: Ship): void {
    this.updateAction(interaction, input);
    this.updateStation(player, ship);
    this.updateHints(player, input);
    this.updatePointerHint(input);
  }

  /**
   * The notice that the camera is loose.
   *
   * The browser only delivers raw mouse movement to whoever has locked the pointer, and
   * locking requires a click — there is no way to do it from the game when the match
   * starts, because the `start` comes from the server and not from a gesture by the
   * player. Whoever does not know that sees a game where WASD walks and the head does not
   * turn, and the reasonable conclusion is that the mouse does not work. One line settles
   * it.
   *
   * It disappears on the controller because there is nothing to settle there: the right
   * stick looks around with no pointer lock at all.
   */
  private updatePointerHint(input: Input): void {
    const show = !input.pointerLocked && !input.usingGamepad;
    if (this.resume.hidden === !show) return;
    this.resume.hidden = !show;
  }

  /** Hides everything — used when going back to the menu. */
  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  dispose(): void {
    this.root.remove();
  }

  private updateAction(interaction: Interaction, input: Input): void {
    const focus = interaction.focus;
    const label = focus?.label() ?? null;

    if (!focus || !label) {
      if (!this.prompt.hidden) this.prompt.hidden = true;
      this.lastLabel = '';
      return;
    }

    this.prompt.hidden = false;

    const key = keyFor(input, 'interact');
    if (key !== this.lastKey) {
      this.promptKey.textContent = key;
      this.lastKey = key;
    }
    if (label !== this.lastLabel) {
      this.promptLabel.textContent = label;
      this.lastLabel = label;
    }

    const progress = focus.progress?.() ?? null;
    if (progress === null) {
      this.promptBar.hidden = true;
    } else {
      this.promptBar.hidden = false;
      // The clamp belongs to the drawing, not to the piece: a bar with `scaleX(3)` only
      // did not spill because the prompt's `overflow: hidden` cropped it. Counting on the
      // crop is counting on nobody changing the CSS.
      const fill = Math.min(Math.max(progress, 0), 1);
      this.promptFill.style.transform = `scaleX(${fill.toFixed(3)})`;
    }
  }

  /** State of the station being operated: only the cannon has anything to say so far. */
  private updateStation(player: PlayerController, ship: Ship): void {
    if (player.station !== 'cannon') {
      if (!this.status.hidden) this.status.hidden = true;
      if (!this.reticle.hidden) this.reticle.hidden = true;
      this.lastStatus = '';
      return;
    }

    this.reticle.hidden = false;
    this.status.hidden = false;

    const cannon = ship.cannons[player.cannonIndex];
    let text: string;
    if (!cannon) text = '';
    else if (cannon.state === 'loading') text = `Loading… ${Math.round(cannon.loadProgress * 100)}%`;
    else if (cannon.state === 'loaded') text = `Loaded · ${ship.cannonballs} shot in the locker`;
    else text = `Empty · ${ship.cannonballs} shot in the locker`;

    if (text !== this.lastStatus) {
      this.status.textContent = text;
      this.lastStatus = text;
    }
  }

  private updateHints(player: PlayerController, input: Input): void {
    const pad = input.usingGamepad;
    const list = hintsFor(player);
    // Serialize before touching the DOM: rebuilding five elements per frame is waste in
    // a panel that changes four times a match.
    //
    // The signature carries a resolved glyph, and not just "there is a controller or
    // not": swapping an Xbox for a DualSense keeps `pad` at `true` and would change every
    // label under the cache, leaving the panel asking for `X` where it now reads `□`.
    const device = pad ? `pad:${input.padLabel('interact')}` : 'kbm';
    const signature = `${device}|${list.map((hint) => hint.text).join('|')}`;
    if (signature === this.lastHints) return;
    this.lastHints = signature;

    this.hints.replaceChildren(
      ...list.map((hint) => {
        const row = document.createElement('div');
        row.className = 'prompts__hint';

        const key = document.createElement('span');
        key.className = 'prompts__key prompts__key--small';
        key.textContent = hint.action
          ? keyFor(input, hint.action)
          : ((pad ? (hint.padKey ?? hint.key) : hint.key) ?? '');

        const text = document.createElement('span');
        text.textContent = hint.text;

        row.append(key, text);
        return row;
      }),
    );
  }
}

/**
 * The key's or button's label for an action, on the device in use.
 *
 * It goes through `Input.padLabel` instead of reading `ACTION_LABELS[...].gamepad`: the
 * table stores the default layout's name (Xbox), and on a Sony controller the prompt said
 * `X` for the button engraved `□` — and `A` for `✕`.
 */
function keyFor(input: Input, action: Action): string {
  return input.usingGamepad ? input.padLabel(action) : ACTION_LABELS[action].keyboard;
}

function hintsFor(player: PlayerController): Hint[] {
  // The water comes first because it is the state the player knows least about: they
  // have just fallen in, the ship is leaving and nothing on screen says what to do. The
  // two lines are the only two things that exist there — and the second says **where**
  // the ladder is, because finding a boarding ladder while swimming beside a
  // sixteen-meter hull is the hard part.
  if (player.inWater) {
    return [
      { action: null, key: 'W A S D', padKey: 'Left stick', text: 'Swim' },
      { action: 'interact', text: 'Climb the boarding ladder, aft on either side' },
    ];
  }

  if (player.onLadder) {
    return [
      { action: null, key: 'W / S', padKey: 'Left stick', text: 'Climb up and down' },
      // The same key that grabbed on, and it is what gives the ladder a way out: whoever
      // climbed up does not have to discover a second command in order to get down.
      { action: 'interact', text: 'Let go' },
    ];
  }

  // The capstan is the only piece on deck that becomes a mode, and it is the one that
  // most needs a hint: without it, whoever takes the bars stands still waiting for a bar
  // to fill on its own instead of starting to walk.
  if (player.atCapstan) {
    return [
      { action: null, key: 'W', padKey: 'Left stick', text: 'Walk forward to heave' },
      { action: 'interact', text: 'Let go of the capstan' },
    ];
  }

  switch (player.station) {
    case 'helm':
      return [
        { action: null, key: 'A / D', padKey: 'Left stick', text: 'Turn the wheel' },
        { action: 'exit', text: 'Leave the helm' },
      ];
    case 'cannon':
      return [
        { action: 'reload', text: 'Load' },
        { action: 'fire', text: 'Fire' },
        { action: 'aim', text: 'Focus aim' },
        { action: 'exit', text: 'Leave the cannon' },
      ];
    default:
      return [
        { action: null, key: 'W A S D', padKey: 'Left stick', text: 'Move' },
        { action: 'sprint', text: 'Sprint' },
        { action: 'jump', text: 'Jump' },
      ];
  }
}
