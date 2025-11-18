#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const MODE = parseMode(process.argv.slice(2));
const FILES = ['AGENTS.md', 'CLAUDE.md'];

const records = FILES.map(readGuidelineFile);
const existingRecords = records.filter((item) => item.exists);
const baseline = selectBaseline(existingRecords);

if (!baseline) {
  console.error('未找到基准文件，至少需要存在一个规范文档用于比对。');
  process.exit(1);
}

const baselineBody = baseline.bodyNormalized;
const baselineRawBody = baseline.body;
let hasConflict = false;
let hasMissing = false;

for (const record of records) {
  if (!record.exists) {
    hasMissing = true;
    if (MODE === 'fix') {
      writeFile(record.filePath, record.frontmatter, baselineRawBody);
      console.log(`已补全缺失文件：${record.fileName}`);
    }
    continue;
  }

  if (!bodiesMatch(baselineBody, record.bodyNormalized)) {
    if (MODE === 'fix') {
      writeFile(record.filePath, record.frontmatter, baselineRawBody);
      console.log(`已同步正文：${record.fileName}`);
    } else {
      hasConflict = true;
      reportConflict(record.fileName, baselineBody, record.bodyNormalized);
    }
  }
}

if (hasConflict) {
  process.exit(1);
}

if (hasMissing && MODE === 'check') {
  console.error('检测到规范文件缺失，请运行 npm run check:fix 同步。');
  process.exit(1);
}

function parseMode(args) {
  for (const arg of args) {
    if (arg === '--fix' || arg === '--mode=fix') return 'fix';
    if (arg === '--check' || arg === '--mode=check') return 'check';
  }
  return 'check';
}

function readGuidelineFile(fileName) {
  const filePath = path.join(process.cwd(), fileName);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const stats = fs.statSync(filePath);
    const { frontmatter, body } = splitFrontmatter(content);
    return {
      fileName,
      filePath,
      exists: true,
      frontmatter,
      body,
      bodyNormalized: normalizeBody(body),
      mtimeMs: stats.mtimeMs,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        fileName,
        filePath,
        exists: false,
        frontmatter: '',
        body: '',
        bodyNormalized: '',
        mtimeMs: 0,
      };
    }
    throw error;
  }
}

function selectBaseline(existing) {
  if (existing.length === 0) return null;
  return existing.reduce((latest, current) => {
    if (!latest) return current;
    if (current.mtimeMs > latest.mtimeMs) return current;
    if (current.mtimeMs === latest.mtimeMs) {
      return current.fileName < latest.fileName ? current : latest;
    }
    return latest;
  });
}

function splitFrontmatter(content) {
  if (content.startsWith('---')) {
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (match) {
      const frontmatter = match[0];
      const body = content.slice(frontmatter.length);
      return { frontmatter, body };
    }
  }
  return { frontmatter: '', body: content };
}

function normalizeBody(body) {
  return body.replace(/\r\n/g, '\n').trim();
}

function bodiesMatch(a, b) {
  return a === b;
}

function reportConflict(fileName, expected, actual) {
  const [expectedLine, actualLine, lineNumber] = firstDifference(expected, actual);
  console.error(
    [
      `文档正文不一致：${fileName}`,
      lineNumber
        ? `首个差异行 ${lineNumber}：\n  基准> ${expectedLine}\n  当前> ${actualLine}`
        : '无法定位差异（可能是空白差异），请手动同步。',
    ].join('\n'),
  );
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const max = Math.max(expectedLines.length, actualLines.length);
  for (let i = 0; i < max; i++) {
    const exp = expectedLines[i] ?? '';
    const act = actualLines[i] ?? '';
    if (exp !== act) {
      return [exp, act, i + 1];
    }
  }
  return ['', '', null];
}

function writeFile(filePath, frontmatter, body) {
  const normalizedBody = normalizeBody(body);
  const finalBody = normalizedBody ? `${normalizedBody}\n` : '';
  const hasFrontmatter = Boolean(frontmatter);
  const needsNewline = hasFrontmatter && !frontmatter.endsWith('\n');
  const prefix = hasFrontmatter ? `${frontmatter}${needsNewline ? '\n' : ''}` : '';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${prefix}${finalBody}`, 'utf8');
}
