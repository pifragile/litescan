import { main } from "./lib.js";


const originalWarn = console.warn;
console.warn = (...args) => {
  if (
    typeof args[0] === 'string' &&
    args[0].includes('Unable to map [u8; 32] to a lookup index')
  ) {
    return; // suppress this specific warning
  }
  originalWarn.apply(console, args);
};


main().catch(console.error);