interface Props {
  missing: string[];
}

export function Unsupported({ missing }: Props) {
  return (
    <div className="unsupported" data-testid="unsupported">
      <div>
        <div className="code">UNSUPPORTED</div>
        <div style={{ fontSize: 18, marginBottom: 12 }}>当前浏览器不支持离线手册所需能力</div>
        <div className="small" data-testid="unsupported-reason">
          缺失：{missing.join('、')}
        </div>
      </div>
    </div>
  );
}
