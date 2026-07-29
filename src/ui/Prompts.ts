/**
 * Prompts contextuais: o que dá para fazer agora, e com que tecla.
 *
 * É HTML sobre o canvas, não texto em 3D. Texto de UI desenhado no mundo custa
 * uma malha e um atlas por frase e ainda sai serrilhado; o DOM já resolve fonte,
 * subpixel e escala de tela de graça, e o custo é zero enquanto nada muda —
 * daí o cuidado de só escrever no DOM quando o conteúdo é diferente.
 *
 * Os rótulos saem de `ACTION_LABELS`, a mesma tabela do remapeamento, e trocam
 * para os botões do controle no instante em que o jogador **encosta** no controle —
 * não quando ele é plugado (ver `Input.activeDevice`). Uma tecla renomeada ali
 * aparece aqui sozinha.
 */

import type { Action } from '../core/Input';
import { ACTION_LABELS, type Input } from '../core/Input';
import type { Interaction } from '../player/Interaction';
import type { PlayerController } from '../player/PlayerController';
import type { Ship } from '../ship/Ship';
import '../styles/prompts.css';

/**
 * Uma dica de comando: a tecla e o que ela faz.
 *
 * A maioria sai de `ACTION_LABELS` pela `action`. As que não saem são os eixos
 * de movimento — não existe "ação" chamada andar para vante, existe um eixo —, e
 * é para elas que serve o par `key`/`padKey`: sem o segundo, o painel continuava
 * pedindo `W / S` para quem está com as duas mãos no controle.
 */
interface Hint {
  action: Action | null;
  key?: string;
  /** Rótulo equivalente no controle. Sem ele, `key` vale para os dois. */
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

    this.root.append(this.reticle, this.status, this.prompt, this.hints);
    parent.appendChild(this.root);
  }

  update(input: Input, interaction: Interaction, player: PlayerController, ship: Ship): void {
    this.updateAction(interaction, input);
    this.updateStation(player, ship);
    this.updateHints(player, input);
  }

  /** Esconde tudo — usado ao voltar para o menu. */
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
      // O grampo é do desenho, não da peça: uma barra com `scaleX(3)` só não
      // vazava porque o `overflow: hidden` do prompt a recortava. Contar com o
      // recorte é contar que ninguém mude o CSS.
      const fill = Math.min(Math.max(progress, 0), 1);
      this.promptFill.style.transform = `scaleX(${fill.toFixed(3)})`;
    }
  }

  /** Estado da peça operada: só o canhão tem algo a dizer por enquanto. */
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
    // Serializa antes de tocar no DOM: reconstruir cinco elementos por frame é
    // desperdício num painel que muda quatro vezes por partida.
    //
    // A assinatura carrega um glifo resolvido, e não só "tem controle ou não":
    // trocar um Xbox por um DualSense mantém `pad` em `true` e mudaria todos os
    // rótulos por baixo do cache, deixando o painel pedindo `X` onde agora se lê
    // `□`.
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
 * Rótulo da tecla ou do botão para uma ação, no aparelho que está em uso.
 *
 * Passa por `Input.padLabel` em vez de ler `ACTION_LABELS[...].gamepad`: a
 * tabela guarda o nome do layout padrão (Xbox), e num controle da Sony o prompt
 * dizia `X` para o botão que está gravado `□` — e `A` para o `✕`.
 */
function keyFor(input: Input, action: Action): string {
  return input.usingGamepad ? input.padLabel(action) : ACTION_LABELS[action].keyboard;
}

function hintsFor(player: PlayerController): Hint[] {
  if (player.onLadder) {
    return [
      { action: null, key: 'W / S', padKey: 'Left stick', text: 'Climb up and down' },
      // A mesma tecla que agarrou, e é o que faz a escada ter saída: quem subiu
      // não precisa descobrir um segundo comando para poder descer.
      { action: 'interact', text: 'Let go' },
    ];
  }

  // O cabrestante é a única peça do convés que vira modo, e é a que mais precisa
  // de dica: sem ela, quem assume as barras fica parado esperando uma barra
  // encher sozinha em vez de sair andando.
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
