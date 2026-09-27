import type { ManualManifest } from '../core/types';

export function StepsPanel({ manifest }: { manifest: ManualManifest }) {
  return (
    <div className="panel" data-testid="steps-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          正确断电步骤 · 版本 {manifest.version}
        </h2>
        <span className="badge active">必须依序执行</span>
      </div>
      <div className="meta" style={{ color: 'var(--muted)', margin: '6px 0 14px' }}>
        {manifest.title} · {manifest.releasedAt}
      </div>
      <ol className="steps" data-testid="step-list">
        {manifest.steps.map((step) => (
          <li key={step.order} data-testid={`step-${step.order}`}>
            <strong>{step.action}</strong>
            <div className="detail">{step.detail}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
