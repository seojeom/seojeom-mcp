type GraphNodeLike = {
  id: string;
  label: string;
  type: string;
  plane: string;
  summary?: string | null;
};

export function preview(value: string | null | undefined, limit = 160) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}...`;
}

export function summarizeGraphNodeRows(rows: GraphNodeLike[]) {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    type: row.type,
    plane: row.plane,
    summary: row.summary ?? null,
  }));
}

export function renderGraphNodeListText(
  title: string,
  rows: Array<{
    id: string;
    label: string;
    type: string;
    plane: string;
    summary?: string | null;
  }>,
) {
  const lines = [`[${title}] ${rows.length}개`];

  for (const row of rows) {
    lines.push(`- ${row.type} · ${row.label} (${row.id})`);
    const summary = preview(row.summary);
    if (summary) {
      lines.push(`  ${summary}`);
    }
  }

  return lines.join("\n");
}
