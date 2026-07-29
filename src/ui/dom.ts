/**
 * Os dois auxiliares de construção que as telas de sobreposição compartilham.
 *
 * Moram fora de `Menu` por uma razão mecânica, e não de arrumação: `OnlineMenu`
 * constrói o próprio DOM e `Menu` constrói `OnlineMenu`. Se os auxiliares ficassem
 * num dos dois, os módulos se importariam em círculo — e um ciclo que hoje
 * funciona por ordem de avaliação é o tipo de coisa que quebra no dia em que
 * alguém troca um `function` por um `const`.
 */

/** Cria um elemento com classe, pai e texto opcionais, na ordem em que se escreve. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

/** Cabeçalho com o logotipo. Usado no título, no online e na tela de fim. */
export function buildBrand(parent: HTMLElement, subtitle: string): void {
  const brand = el('div', 'brand', parent);
  el('h1', 'brand__title', brand, 'Sea of Opus');
  const rule = el('div', 'brand__rule', brand);
  el('span', 'brand__diamond', rule);
  el('p', 'brand__subtitle', brand, subtitle);
}
