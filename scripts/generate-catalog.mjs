/**
 * 生成内置手册目录 src/manuals/catalog.json。
 * 扫描 public/manuals/<version>/ 下的 manifest.json 与 faults.json，
 * 计算 SHA-256（与安装时校验使用同一摘要），输出版本号、同源 URL、SHA-256、
 * 步骤数与发布时间。顺序步骤的正文保存在各版本 manifest.json 中。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manualsDir = path.join(root, 'public', 'manuals');
const outFile = path.join(root, 'src', 'manuals', 'catalog.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const versionDirs = readdirSync(manualsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const entries = versionDirs.map((dir) => {
  const base = `/manuals/${dir}`;
  const manifestRaw = readFileSync(path.join(manualsDir, dir, 'manifest.json'), 'utf8');
  const faultsRaw = readFileSync(path.join(manualsDir, dir, 'faults.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const faults = JSON.parse(faultsRaw);

  if (!manifest.version || manifest.version !== faults.version) {
    throw new Error(`${dir}: 清单版本号与故障条目版本号不一致`);
  }
  if (!Array.isArray(manifest.steps) || manifest.steps.length === 0) {
    throw new Error(`${dir}: 缺少有序步骤`);
  }
  manifest.steps.forEach((s, i) => {
    if (s.order !== i + 1) throw new Error(`${dir}: 步骤顺序必须从 1 连续编号`);
  });
  if (!Array.isArray(faults.entries) || faults.entries.length === 0) {
    throw new Error(`${dir}: 缺少故障条目`);
  }

  const resources = [
    { url: `${base}/manifest.json`, sha256: sha256(Buffer.from(manifestRaw)), kind: 'manual' },
    { url: `${base}/faults.json`, sha256: sha256(Buffer.from(faultsRaw)), kind: 'faults' },
  ];

  return {
    version: manifest.version,
    releasedAt: manifest.releasedAt,
    title: manifest.title,
    stepCount: manifest.steps.length,
    resources,
  };
});

writeFileSync(outFile, `${JSON.stringify({ generated: true, entries }, null, 2)}\n`, 'utf8');
console.log(`已生成目录: ${entries.map((e) => e.version).join(', ')} -> ${path.relative(root, outFile)}`);
