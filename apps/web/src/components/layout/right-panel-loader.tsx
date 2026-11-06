import {
  Activity,
  Component,
  Suspense,
  lazy,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui';
import { tr } from '@/lib/i18n';

class PanelLoadBoundary extends Component<
  {
    children: ReactNode;
    onRetry: () => void;
    renderError?: ((retry: () => void) => ReactNode) | undefined;
  },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed && this.props.renderError)
      return this.props.renderError(this.props.onRetry);
    return this.state.failed ? (
      <div role="alert" className="p-5 text-small text-fg-muted">
        <p className="mb-3">{tr('面板加载失败')}</p>
        <Button variant="secondary" onClick={this.props.onRetry}>
          {tr('重新加载')}
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}

/** 第一次显示才加载；隐藏后保留 DOM 与组件状态，Activity 释放查询订阅和其它 effects。 */
export function DeferredPanel<Props extends object>({
  active,
  load,
  componentProps,
  fallback,
  renderError,
}: {
  active: boolean;
  load: () => Promise<{ default: ComponentType<Props> }>;
  componentProps: Props;
  fallback?: ReactNode;
  renderError?: ((retry: () => void) => ReactNode) | undefined;
}) {
  const [hasOpened, setHasOpened] = useState(active);
  const [attempt, setAttempt] = useState(0);
  const [Panel, setPanel] = useState(() => lazy(load));
  if (active && !hasOpened) setHasOpened(true);
  if (!active && !hasOpened) return null;
  return (
    <Activity mode={active ? 'visible' : 'hidden'}>
      <PanelLoadBoundary
        key={attempt}
        renderError={renderError}
        onRetry={() => {
          setPanel(() => lazy(load));
          setAttempt((value) => value + 1);
        }}
      >
        <Suspense
          fallback={
            fallback ?? (
              <p role="status" className="p-5 text-small text-fg-muted">
                {tr('正在加载面板…')}
              </p>
            )
          }
        >
          <Panel {...componentProps} />
        </Suspense>
      </PanelLoadBoundary>
    </Activity>
  );
}
