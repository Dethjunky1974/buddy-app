import fs from 'node:fs';
import path from 'node:path';

const files = {
  'Knowledge/README.md': `# LLM Wiki

This optional knowledge base follows [Andrej Karpathy's LLM Wiki idea](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

- [raw/](raw/README.md) holds source material. Agents may read it, but must not edit or delete sources.
- [wiki/](wiki/index.md) holds agent-maintained Markdown pages, links, and synthesis.
- [AGENTS.md](AGENTS.md) defines the writing and maintenance rules for Codex and Claude Code.

Add a source to raw/, then ask an agent to ingest it. Review the resulting wiki pages in Obsidian. Existing vault notes outside Knowledge/ stay as they are.
`,
  'Knowledge/AGENTS.md': `# LLM Wiki writing rules

These rules apply to the Knowledge/ directory. Follow the user's instructions first.

## Ownership

- Treat raw/ as the immutable source of truth. Read source files; never edit, move, or delete them during an ingest or lint pass.
- Maintain wiki/ as a persistent, interlinked Markdown knowledge base. The agent writes and updates it; the user curates sources and reviews the result.
- Keep this schema current with the user's agreed conventions. Do not silently change its rules.

## Before writing

1. Read wiki/index.md, the relevant existing pages, and the source material.
2. Find the right existing page before creating a new one. Prefer updating a page to making a duplicate.
3. Trace factual claims to source files. Mark uncertainty and conflicting sources explicitly; never invent evidence.

## Ingest

Discuss key takeaways with the user when the task calls for review. Then add or revise only relevant wiki pages. Link related pages with Obsidian wikilinks and cite source files with relative Markdown links. Update wiki/index.md with a link and one-line summary for each new page. Append a dated entry to wiki/log.md. Do not rewrite the log.

## Query

Read wiki/index.md first, then the relevant pages and raw sources where needed. Cite the pages and sources used. If an answer adds durable insight, offer to write it back to the wiki; do not silently turn every chat into a wiki edit.

## Lint

Check for contradictions, stale claims, orphan pages, missing links, and gaps in source coverage. Report problems and repair wiki/ only when authorized. Never change raw/ to make a wiki page appear correct.

## Page format

Use a clear title, a short summary, sections suited to the topic, links to related pages, and a Sources section. Keep an evidence trail for important dates, numbers, quotations, and decisions. Do not copy long source passages into the wiki.

Only apply these writing rules to knowledge-base work. Unrelated coding prompts do not require wiki changes.
`,
  'Knowledge/CLAUDE.md': `# LLM Wiki

Read and follow [AGENTS.md](AGENTS.md) before writing inside this Knowledge/ directory. The same schema applies to Claude Code and Codex.
`,
  'Knowledge/raw/README.md': `# Raw sources

Put original notes, articles, transcripts, and other curated source files here. Once added, treat them as immutable. Add a corrected or newer source rather than editing the original. The wiki may summarize and link to these files, but must not rewrite them.
`,
  'Knowledge/wiki/index.md': `# Wiki index

Start here. Add each maintained wiki page with a link and one-line summary. Group related pages as the wiki grows.

- [[Knowledge/wiki/overview|Overview]] — What this knowledge base covers and where to start.
`,
  'Knowledge/wiki/overview.md': `# Overview

This page is the evolving synthesis of the sources in [raw/](../raw/README.md). Ask Codex or Claude Code to update it as knowledge is ingested.

## Current understanding

No sources ingested yet.

## Sources

No sources yet.
`,
  'Knowledge/wiki/log.md': `# Wiki log

Append entries in the format \`## [YYYY-MM-DD] action | description\`. Record ingests, significant query writebacks, and lint passes. Preserve earlier entries.
`
};

export function createWikiStarter(vaultPath) {
  for (const relative of Object.keys(files)) {
    const filename = path.join(vaultPath, relative);
    let parent = path.dirname(filename);
    while (parent !== vaultPath && parent.startsWith(vaultPath + path.sep)) {
      if (fs.existsSync(parent) && (!fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()))
        throw new Error(`Wiki setup cannot write through ${path.relative(vaultPath, parent)}.`);
      parent = path.dirname(parent);
    }
    if (fs.existsSync(filename) && (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()))
      throw new Error(`Wiki setup cannot use ${relative}.`);
  }
  const created = [];
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(vaultPath, relative);
    if (fs.existsSync(filename)) continue;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    try { fs.writeFileSync(filename, content, { flag: 'wx' }); created.push(relative); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return created;
}
