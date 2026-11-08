// `vue-tsc -p web`, run on TypeScript 6. vue-tsc drives TypeScript's classic
// JS API, which TypeScript 7 (the native compiler the server is checked with)
// no longer ships; @typescript/typescript6 is Microsoft's side-by-side copy.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('vue-tsc').run(require.resolve('@typescript/typescript6/lib/tsc'));
