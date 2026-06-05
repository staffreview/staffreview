// Registers happy-dom globals (document, window, etc.) before `bun test` so
// React component tests can render into a DOM. Wired up via `[test] preload`
// in bunfig.toml. Pure-logic tests are unaffected — they simply don't touch
// the globals this provides.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Tell React this is an act()-aware environment so `act(...)` flushes effects
// and updates synchronously instead of warning. See react docs: testing envs.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
