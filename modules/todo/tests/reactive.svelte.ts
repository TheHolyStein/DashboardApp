/** Props that a test can change after mounting (the compiler only allows runes in `.svelte.ts` files). */
export function reactiveProps<T extends object>(initial: T): T {
  const props = $state(initial);
  return props;
}
