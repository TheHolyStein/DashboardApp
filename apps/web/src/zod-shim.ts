// Every `import 'zod'` in the web build resolves here (see vite.config.ts resolve.alias).
// Zod 4 probes `new Function('')` when a schema is built; the server's CSP forbids eval,
// so disable the probe before any schema exists. Do not import 'zod' in this file: that would loop.
import * as zod from 'zod/v4';
zod.config({ jitless: true });
export * from 'zod/v4';
export { zod as default };
