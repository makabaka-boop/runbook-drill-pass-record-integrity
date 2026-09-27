import type { CatalogEntry, FaultEntry, ManualManifest } from '../core/types';
import catalogJson from './catalog.json';

export interface ManualBundle {
  manifest: ManualManifest;
  faults: FaultEntry[];
}

export const catalog: CatalogEntry[] = (catalogJson as { entries: CatalogEntry[] }).entries;

export const findEntry = (version: string): CatalogEntry | undefined =>
  catalog.find((c) => c.version === version);

/**
 * 从已安装的同源 URL 获取手册（离线时 SW 只从当前激活代际缓存返回）。
 * 同时校验返回内容与目录中登记的 SHA-256，任何不符都视为不可用。
 */
export async function loadManual(version: string): Promise<ManualBundle> {
  const entry = findEntry(version);
  if (!entry) throw new Error(`目录中不存在版本 ${version}`);

  const responses = await Promise.all(
    entry.resources.map((ref) => fetch(ref.url, { cache: 'no-store' })),
  );
  if (responses.some((r) => !r.ok)) {
    throw new Error('手册资源读取失败');
  }
  const buffers = await Promise.all(responses.map((r) => r.arrayBuffer()));
  const digest = async (buf: ArrayBuffer) => {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };
  const hashes = await Promise.all(buffers.map((b) => digest(b)));
  entry.resources.forEach((ref, i) => {
    if (hashes[i] !== ref.sha256.toLowerCase()) {
      throw new Error(`手册内容校验失败: ${ref.url}`);
    }
  });

  const manifestRef = entry.resources.find((r) => r.kind === 'manual');
  const faultsRef = entry.resources.find((r) => r.kind === 'faults');
  const manifestIndex = entry.resources.indexOf(manifestRef!);
  const faultsIndex = entry.resources.indexOf(faultsRef!);
  const manifest = JSON.parse(new TextDecoder().decode(buffers[manifestIndex])) as ManualManifest;
  const faultsDoc = JSON.parse(new TextDecoder().decode(buffers[faultsIndex])) as {
    entries: FaultEntry[];
  };
  if (manifest.version !== version) throw new Error('手册版本不匹配');
  return { manifest, faults: faultsDoc.entries };
}
