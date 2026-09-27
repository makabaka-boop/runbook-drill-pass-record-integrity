import { detectCapabilities } from './platform/capabilities';
import { registerServiceWorker } from './platform/register-sw';
import { useEffect, useState } from 'react';
import { Booted } from './components/Booted';
import { Unsupported } from './components/Unsupported';

export default function App() {
  const [cap] = useState(() => detectCapabilities());
  const [swState, setSwState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [swError, setSwError] = useState<string>('');

  useEffect(() => {
    if (!cap.supported) return;
    let alive = true;
    registerServiceWorker()
      .then(() => alive && setSwState('ready'))
      .catch((err: Error) => {
        if (!alive) return;
        setSwError(err.message || String(err));
        setSwState('error');
      });
    return () => {
      alive = false;
    };
  }, [cap.supported]);

  if (!cap.supported) {
    return <Unsupported missing={cap.missing} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>地下机房断电 · 离线作业手册</h1>
        <span className="sub">无后端 · 无在线服务 · 手册仅在完整校验后激活</span>
      </header>
      {swState === 'loading' && (
        <div className="banner info" data-testid="sw-loading">
          正在初始化离线服务（Service Worker）…
        </div>
      )}
      {swState === 'error' && (
        <div className="banner error" data-testid="sw-error">
          离线服务启动失败：{swError}
          <div className="small">请确认站点运行在安全上下文（https 或 localhost / 已授权的测试源）。</div>
        </div>
      )}
      <Booted swReady={swState === 'ready'} />
    </div>
  );
}
