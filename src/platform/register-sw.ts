/** 注册 Service Worker 并等待其接管页面（clients.claim 之后）。 */
export async function registerServiceWorker(
  w: Window = window,
  scriptUrl = '/service-worker.js',
): Promise<ServiceWorkerRegistration> {
  const registration = await w.navigator.serviceWorker.register(scriptUrl);

  // 若已有控制器（重载场景），无需再等待。
  if (w.navigator.serviceWorker.controller) {
    return registration;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = w.setTimeout(() => {
      w.navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      reject(new Error('等待 Service Worker 接管超时'));
    }, 15000);
    const onChange = () => {
      w.clearTimeout(timeout);
      w.navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve();
    };
    w.navigator.serviceWorker.addEventListener('controllerchange', onChange);
  });

  return registration;
}
