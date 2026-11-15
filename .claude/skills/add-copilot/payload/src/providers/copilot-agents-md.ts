/**
 * AGENTS.md spec for copilot agent groups (legacy-host compatibility path).
 *
 * On contract cores (`src/provider-contracts/copilot.ts`), AGENTS.md is
 * composed from the core-owned canonical template using the declared
 * `instructions` facts. On older cores, this module preserves the exact
 * runtime-contract base document and sections.
 */
import path from 'path';
import { composeGroupProjectDoc, type ProjectDocSpec } from '../project-doc-compose.js';
import type { AgentGroup } from '../types.js';

export const COPILOT_PROJECT_DOC_MAX_BYTES = 32 * 1024;

export const COPILOT_PROJECT_DOC_EXTRA_SECTIONS = [
  {
    name: 'Memory System',
    body: [
      'The live memory index and definition are supplied by NanoClaw at session startup, clear, and after compaction.',
      'Editable memory-system definition: `/workspace/agent/memory/system/definition.md`.',
      'Top memory index: `/workspace/agent/memory/index.md`.',
      'Read the definition and index, then use linked memory files and conversation archives when relevant.',
      'Stored user preferences are binding: read any linked memory file relevant to the user or the request, and apply it without being asked.',
      'Do not use `.github/copilot-instructions.md` or `AGENTS.override.md` for memory.',
    ].join('\n\n'),
  },
  {
    name: 'Native Runtime Skills',
    body: [
      'Selected NanoClaw runtime skills are available as agent skills at `/workspace/agent/.agents/skills`.',
      'Each skill directory contains a `SKILL.md` with its trigger description plus any supporting files, and points to the read-only shared skill source under `/app/skills`.',
      'Use skill discovery to load these skills only when their descriptions match the task. A skill whose rules must hold before the task is recognised ships an `instructions.md` instead, and those arrive inlined as `NanoClaw Skill:` sections of this document.',
      'Skills YOU author or install yourself go in `~/.copilot/skills/<name>/SKILL.md` — persistent across sessions and discovered automatically. Never write skills elsewhere: paths outside `~/.copilot` and `~/.agents` are ephemeral or not discovered.',
    ].join('\n\n'),
  },
];

const COPILOT_PROJECT_DOC: ProjectDocSpec = {
  fileName: 'AGENTS.md',
  baseDocPath: path.join('container', 'AGENTS.md'),
  extraSections: COPILOT_PROJECT_DOC_EXTRA_SECTIONS,
  maxBytes: COPILOT_PROJECT_DOC_MAX_BYTES,
};

export function composeGroupAgentsMd(group: AgentGroup, groupDir: string): Promise<void> {
  return composeGroupProjectDoc(group, groupDir, COPILOT_PROJECT_DOC);
}
