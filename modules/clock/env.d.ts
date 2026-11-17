declare module '*.svelte' {
  import type { Component } from 'svelte';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- components are generic over their props
  const component: Component<any>;
  export default component;
}

// @dash/ui's Chart imports uPlot's stylesheet; modules type-check that source too.
declare module 'uplot/dist/uPlot.min.css';
