// Node loader hook for running the server's TypeScript sources directly (used by the `cli` script).
// Sources import siblings as `./x.js` (required by tsc NodeNext); when that file does not exist, retry `./x.ts`.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (/^\.{1,2}\//.test(specifier) && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});
