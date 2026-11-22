declare module '*.svelte' {
  import type { Component } from 'svelte';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- sample components are generic over their props
  const component: Component<any>;
  export default component;
}
