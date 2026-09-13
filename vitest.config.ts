// Tests run through Vitest's transpiler rather than tsc.
//
// The suite is the ported js/*.test.mjs, and its assertions were written against
// runtime shapes. Making 885 lines of them satisfy strictNullChecks would have
// meant rewriting the assertions — changing what is being tested — to migrate a
// build tool. The shipped code in src/ and services/ is strictly typechecked;
// the tests are executed, which is the thing that actually protects the port.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
