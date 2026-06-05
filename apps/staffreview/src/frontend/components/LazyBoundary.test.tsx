/// <reference lib="dom" />

import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LazyBoundary } from "./LazyBoundary.tsx";

// Minimal manual render/cleanup (no @testing-library to keep the surface small).
let container: HTMLElement | null = null;
let root: Root | null = null;

function mountInto(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

// Flush microtasks (the resolved/rejected import promise) inside act so React
// commits the Suspense/error transition before we assert.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function Loaded() {
  return <div data-testid="loaded">loaded</div>;
}

test("renders the lazy component once its import resolves", async () => {
  const importer = mock(() => Promise.resolve({ default: Loaded as ComponentType }));

  mountInto(
    <LazyBoundary
      importer={importer}
      props={{}}
      loadingFallback={<div data-testid="loading">loading</div>}
      errorFallback={(retry) => (
        <button type="button" data-testid="retry" onClick={retry}>
          retry
        </button>
      )}
    />,
  );

  await flush();

  expect(container?.querySelector('[data-testid="loaded"]')).not.toBeNull();
  expect(importer).toHaveBeenCalledTimes(1);
});

test("keeps the lazy instance stable across re-renders (importer runs once)", async () => {
  // Guards the stability invariant: LazyBoundary holds the lazy() component in
  // useState so an unrelated re-render (here, a new `props` object) does NOT
  // recompute lazy(importer) and re-import the chunk. A refactor to a
  // render-time `const lazyComponent = lazy(importer)` would fire the importer
  // on every re-render and fail this assertion.
  const importer = mock(() => Promise.resolve({ default: Loaded as ComponentType }));

  function render(props: Record<string, unknown>) {
    act(() => {
      root?.render(
        <LazyBoundary
          importer={importer}
          props={props}
          loadingFallback={<div data-testid="loading">loading</div>}
          errorFallback={(retry) => (
            <button type="button" data-testid="retry" onClick={retry}>
              retry
            </button>
          )}
        />,
      );
    });
  }

  mountInto(
    <LazyBoundary
      importer={importer}
      props={{ a: 1 }}
      loadingFallback={<div data-testid="loading">loading</div>}
      errorFallback={(retry) => (
        <button type="button" data-testid="retry" onClick={retry}>
          retry
        </button>
      )}
    />,
  );

  await flush();
  expect(container?.querySelector('[data-testid="loaded"]')).not.toBeNull();
  expect(importer).toHaveBeenCalledTimes(1);

  // Re-render the same boundary with a *new* props object. The lazy instance
  // must stay the same, so the importer is not invoked again.
  render({ a: 2 });
  await flush();

  expect(importer).toHaveBeenCalledTimes(1);
  expect(container?.querySelector('[data-testid="loaded"]')).not.toBeNull();
});

test("shows the error fallback and RECOVERS when Retry re-runs the import", async () => {
  // React logs the caught error to console.error; that's expected here — the
  // whole point is that the boundary catches it. Silence it so the test output
  // isn't littered with the intentional failure's stack.
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});

  // Reject the first import (a chunk-load failure), resolve every retry after.
  let calls = 0;
  const importer = mock(() => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("chunk load failed"))
      : Promise.resolve({ default: Loaded as ComponentType });
  });

  mountInto(
    <LazyBoundary
      importer={importer}
      props={{}}
      loadingFallback={<div data-testid="loading">loading</div>}
      errorFallback={(retry) => (
        <button type="button" data-testid="retry" onClick={retry}>
          retry
        </button>
      )}
    />,
  );

  await flush();

  // The failed import surfaced the error fallback, not the component.
  const retryButton = container?.querySelector('[data-testid="retry"]') as HTMLButtonElement | null;
  expect(retryButton).not.toBeNull();
  expect(container?.querySelector('[data-testid="loaded"]')).toBeNull();
  expect(importer).toHaveBeenCalledTimes(1);

  // Click Retry. The regression this guards: a no-op retry that re-keyed a
  // module-level lazy() would re-throw the cached rejection and never call the
  // importer again. A correct retry rebuilds lazy() and re-invokes the importer.
  act(() => retryButton?.click());
  await flush();

  expect(importer).toHaveBeenCalledTimes(2);
  expect(container?.querySelector('[data-testid="loaded"]')).not.toBeNull();
  expect(container?.querySelector('[data-testid="retry"]')).toBeNull();

  errorSpy.mockRestore();
});
