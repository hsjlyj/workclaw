import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outputPath = path.join(projectRoot, 'src/generated/claw-prompts.js');

function cleanMarkdown(text) {
  return String(text || '').replace(/\r\n?/g, '\n').trim();
}

function toTemplateLiteral(text) {
  const body = cleanMarkdown(text)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  return `\`${body}\``;
}

async function readMarkdown(name) {
  return fs.readFile(path.join(projectRoot, name), 'utf8');
}

async function main() {
  const [soul, user] = await Promise.all([readMarkdown('soul.md'), readMarkdown('user.md')]);

  const output = [
    '// Generated from soul.md and user.md. Do not edit manually.',
    `export const CLAW_SOUL_MD = ${toTemplateLiteral(soul)};`,
    `export const CLAW_USER_MD = ${toTemplateLiteral(user)};`,
    "export const CLAW_SYSTEM_PROMPT = [CLAW_SOUL_MD, CLAW_USER_MD].filter(Boolean).join('\\n\\n');",
    '',
  ].join('\n');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, output, 'utf8');
  console.log('✅ Prompts generated successfully');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
