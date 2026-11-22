// Helpers for locating one Codex session (root thread + sub-agents) inside a snapshot.

/** Returns the root session that contains thread `id` (the session itself or one of its sub-agents). */
export function findSession(snapshot, id) {
  if (!id) return null;
  const contains = (n) => n.id === id || n.children.some(contains);
  return snapshot.sessions.find(contains) || null;
}

export function countAgents(node) {
  return node.children.reduce((a, c) => a + 1 + countAgents(c), 0);
}

export function isRunning(node) {
  return node.status === 'running' || node.children.some(isRunning);
}
