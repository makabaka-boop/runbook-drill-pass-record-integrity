import type { CatalogEntry, FailureCode } from '../core/types';

export interface InstallProgress {
  version: string;
  progress: number;
  completed: number;
  total: number;
  cancelRequested: boolean;
}

export interface InstallFailure {
  version: string | null;
  code: FailureCode;
}

export interface ActivatedInfo {
  version: string;
}

export interface InstallControlsProps {
  catalog: CatalogEntry[];
  activeVersion: string | null;
  swReady: boolean;
  installing: InstallProgress | null;
  failed: InstallFailure | null;
  activated?: ActivatedInfo | null;
  failureText: Record<FailureCode, string>;
  onInstall: (version: string) => void;
  onCancel: () => void;
}

export function VersionCard({
  entry,
  activeVersion,
  swReady,
  installing,
  failed,
  onInstall,
  onCancel,
  compact,
}: {
  entry: CatalogEntry;
  activeVersion: string | null;
  swReady: boolean;
  installing: InstallProgress | null;
  failed: InstallFailure | null;
  onInstall: (version: string) => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  const isActive = entry.version === activeVersion;
  const isInstallingThis = installing?.version === entry.version;
  const failedHere = failed?.version === entry.version;

  return (
    <div className="card" data-testid={`catalog-card-${entry.version}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>
          版本 {entry.version}
          {isActive && (
            <span className="badge active" data-testid={`active-badge-${entry.version}`} style={{ marginLeft: 8 }}>
              当前版
            </span>
          )}
        </strong>
        <span className="small">{entry.releasedAt} 发布</span>
      </div>
      {!compact && <div className="meta">{entry.title}</div>}
      <div className="meta">
        {entry.stepCount} 个有序步骤 · {entry.resources.length} 个同源资源（SHA-256 校验）
      </div>

      {isInstallingThis && installing && (
        <div data-testid={`installing-${entry.version}`}>
          <div className="small">
            正在下载并校验 {installing.completed}/{installing.total}（{installing.progress}%）…
            {installing.cancelRequested && ' 正在取消…'}
          </div>
          <div className="progress">
            <span style={{ width: `${installing.progress}%` }} />
          </div>
          <button className="danger" data-testid={`cancel-${entry.version}`} onClick={onCancel}>
            取消安装
          </button>
        </div>
      )}

      {!isInstallingThis && (
        <button
          className={isActive ? '' : 'primary'}
          data-testid={`install-${entry.version}`}
          disabled={!swReady || (installing !== null && installing.version !== entry.version)}
          onClick={() => onInstall(entry.version)}
        >
          {isActive ? '重新下载并校验（重装）' : `安装并激活 ${entry.version}`}
        </button>
      )}

      {failedHere && failed && (
        <div className="banner error" data-testid={`fail-${entry.version}`} style={{ marginTop: 10 }}>
          {failureTextOf(failed.code)}
        </div>
      )}
    </div>
  );
}

const failureTextOf = (code: FailureCode): string => {
  const map: Record<FailureCode, string> = {
    checksum: '资源校验失败（SHA-256 不匹配），未激活缓存已清理',
    network: '下载中断或网络不可用，未激活缓存已清理',
    quota: '存储空间配额异常，未激活缓存已清理',
    canceled: '安装已取消，未激活缓存已清理',
    unknown: '安装发生未知错误，未激活缓存已清理',
  };
  return map[code];
};
