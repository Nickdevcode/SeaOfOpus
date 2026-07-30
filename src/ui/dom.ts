/**
 * The two building helpers the overlay screens share.
 *
 * They live outside `Menu` for a mechanical reason, and not for tidiness: `OnlineMenu`
 * builds its own DOM and `Menu` builds `OnlineMenu`. If the helpers lived in either one,
 * the modules would import each other in a circle — and a cycle that works today by
 * evaluation order is the kind of thing that breaks the day somebody swaps a `function`
 * for a `const`.
 */

/** Creates an element with optional class, parent and text, in the order you write it. */
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

/** The header with the wordmark. Used on the title, on online and on the end screen. */
export function buildBrand(parent: HTMLElement, subtitle: string): void {
  const brand = el('div', 'brand', parent);
  el('h1', 'brand__title', brand, 'Sea of Opus');
  const rule = el('div', 'brand__rule', brand);
  el('span', 'brand__diamond', rule);
  el('p', 'brand__subtitle', brand, subtitle);
}
