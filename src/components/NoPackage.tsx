import type { CatalogEntry, FailureCode } from '../core/types';
import { VersionCard, type InstallFailure, type InstallProgress } from './InstallControls';

interface Props {
  catalog: CatalogEntry[];
  swReady: boolean;
  installing: InstallProgress | null;
  failed: InstallFailure | null;
  failureText: Record<FailureCode, string>;
  onInstall: (version: string) => void;
  onCancel: () => void;
}

/** 首次安装从未成功 / 失败后的页面：明确提示“无可用离线包”。 */
export function NoPackage({ catalog, swReady, installing, failed, onInstall, onCancel }: Props) {
  return (
    <>
      <div className="banner warn" data-testid="no-package">
        无可用离线包。当前没有任何完整校验并激活的手册版本；必须在联网环境完整安装一个版本后，
        断网才能查阅断电步骤。安装中途失败不会产生可用手册。
      </div>

      {failed && failed.version === null && (
        <div className="banner error" data-testid="fail-general">
          上次安装未完成，请重试。
        </div>
      )}

      <div className="panel">
        <h2>内置手册版本</h2>
        {catalog.map((entry) => (
          <VersionCard
            key={entry.version}
            entry={entry}
            activeVersion={null}
            swReady={swReady}
            installing={installing}
            failed={failed}
            onInstall={onInstall}
            onCancel={onCancel}
          />
        ))}
      </div>
    </>
  );
}
