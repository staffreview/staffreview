import {
  Component,
  type ComponentType,
  createElement,
  lazy,
  type ReactNode,
  Suspense,
  useState,
} from "react";

/**
 * Lazy-loads a component via `importer`, rendering `loadingFallback` while the
 * chunk loads and a recoverable error UI if the dynamic `import()` rejects.
 *
 * Without this, a rejected chunk load — most often after a redeploy when the
 * old hashed chunk filename is gone, or on a flaky/offline network —
 * propagates past `Suspense` to the app root and unmounts the whole tree,
 * leaving the user a blank screen. The `errorFallback` here catches that and
 * offers a retry that genuinely recovers.
 *
 * **Why this owns the `lazy()` call.** A `React.lazy` component memoizes its
 * import: once the underlying `import()` rejects, React caches the rejection on
 * the payload and re-throws it on every subsequent render — re-mounting the
 * subtree does *not* re-run `import()`. So a retry that only re-keys a stable,
 * module-level `lazy` component is a no-op: the cached rejection re-throws and
 * the error fallback flashes straight back.
 *
 * To make retry actually work we must construct a *fresh* `lazy()` instance
 * (status -1) so React re-invokes the importer. `LazyBoundary` therefore takes
 * the `importer` itself and rebuilds the lazy component held in state on each
 * retry.
 */
export function LazyBoundary<P extends object>({
  importer,
  props,
  loadingFallback,
  errorFallback,
}: {
  /**
   * Dynamic-import factory resolving to the component's default export, e.g.
   * `() => import("./MarkdownEditor.tsx").then((m) => ({ default: m.MarkdownEditor }))`.
   * Recreated lazily on each retry so a failed import is genuinely re-attempted.
   */
  importer: () => Promise<{ default: ComponentType<P> }>;
  /** Props forwarded to the lazily-loaded component. */
  props: P;
  /** Shown while the chunk is loading. */
  loadingFallback: ReactNode;
  /**
   * Shown when the chunk fails to load. `retry` rebuilds the lazy component
   * from a fresh `import()`, so it genuinely recovers once the network/asset
   * is reachable again.
   */
  errorFallback: (retry: () => void) => ReactNode;
}) {
  // Each new lazy() is a fresh payload (status -1) => the importer runs again on
  // retry. Holding it in state (vs. deriving from a prop) keeps the instance
  // stable across unrelated re-renders so the chunk isn't re-imported needlessly.
  const [lazyComponent, setLazyComponent] = useState(() => lazy(importer));

  const retry = () => setLazyComponent(() => lazy(importer));

  return (
    <ChunkErrorBoundary fallback={errorFallback} onRetry={retry}>
      <Suspense fallback={loadingFallback}>{createElement(lazyComponent, props)}</Suspense>
    </ChunkErrorBoundary>
  );
}

type BoundaryProps = {
  children: ReactNode;
  fallback: (retry: () => void) => ReactNode;
  /** Rebuilds the lazy component upstream so the import is re-attempted. */
  onRetry: () => void;
};

class ChunkErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  retry = () => {
    // Ask the parent for a fresh lazy() instance (a re-keyed but identical
    // module-level lazy would just re-throw its cached rejection), then clear
    // the error so the new instance gets a chance to render.
    this.props.onRetry();
    this.setState({ failed: false });
  };

  override render() {
    if (this.state.failed) {
      return this.props.fallback(this.retry);
    }
    return this.props.children;
  }
}
