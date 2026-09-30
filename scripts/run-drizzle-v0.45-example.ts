import { runExample } from '../examples/drizzle/v0.45/app.js';
import { assertDisposable } from '../test/disposable.js';

console.log(await runExample(assertDisposable, new Uint8Array(32).fill(71)));
