export type AriaSnapshotNode = {
  role?: string;
  name?: string;
  text?: string;
  ref?: string;
  cursor?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean;
  active?: boolean;
  level?: number;
  url?: string;
  placeholder?: string;
  box?: { x: number; y: number; width: number; height: number };
  children?: Array<AriaSnapshotNode | string>;
};

export const TREE_MAX_CHARS = 20000;
export const TREE_MAX_LINES = 600;
export const TEXT_MAX_CHARS = 8000;
export const NODE_NAME_MAX = 160;
export const NODE_TEXT_MAX = 400;

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "searchbox",
]);

const FRAME_REF_PATTERN = /^f\d+e\d+$/;
const STATE_FIELDS = [
  "checked",
  "disabled",
  "expanded",
  "selected",
  "pressed",
  "active",
  "level",
  "url",
  "placeholder",
] as const;

const normalize = (value: string, max?: number) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return max === undefined ? normalized : normalized.slice(0, max);
};

const stateSuffix = (node: AriaSnapshotNode) => {
  let suffix = "";
  for (const field of STATE_FIELDS) {
    const value = node[field];
    if (value === undefined || value === false || value === "") continue;
    suffix += ` [${field}=${value}]`;
  }
  return suffix;
};

const boxSuffix = (node: AriaSnapshotNode, role: string) => {
  if (!node.ref || !node.box || FRAME_REF_PATTERN.test(node.ref)) return "";
  if (!INTERACTIVE_ROLES.has(role) && node.cursor !== "pointer") return "";
  const { x, y, width, height } = node.box;
  return ` [box=${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}]`;
};

export const serializeAriaSnapshot = (
  nodes: AriaSnapshotNode[],
): { tree: string; text: string; truncated: boolean } => {
  let tree = "";
  let treeLines = 0;
  let treeStopped = false;
  let text = "";
  let textStopped = false;
  let truncated = false;

  const appendTreeLine = (line: string) => {
    if (treeStopped) return;
    if (treeLines >= TREE_MAX_LINES) {
      treeStopped = true;
      truncated = true;
      return;
    }
    const candidate = tree ? `\n${line}` : line;
    if (tree.length + candidate.length <= TREE_MAX_CHARS) {
      tree += candidate;
      treeLines++;
      return;
    }
    tree += candidate.slice(0, TREE_MAX_CHARS - tree.length);
    treeStopped = true;
    truncated = true;
  };

  const appendText = (value: string) => {
    if (textStopped) return;
    const normalized = normalize(value);
    if (!normalized) return;
    const candidate = text ? `\n${normalized}` : normalized;
    if (text.length + candidate.length <= TEXT_MAX_CHARS) {
      text += candidate;
      return;
    }
    text += candidate.slice(0, TEXT_MAX_CHARS - text.length);
    textStopped = true;
    truncated = true;
  };

  const visit = (node: AriaSnapshotNode, depth: number) => {
    const role = node.role || "generic";
    const name = normalize(node.name ?? "", NODE_NAME_MAX);
    const nodeText = normalize(node.text ?? "", NODE_TEXT_MAX);
    const line = `${"  ".repeat(depth)}- ${role}` +
      (name ? ` "${name}"` : "") +
      (node.ref ? ` [ref=${node.ref}]` : "") +
      stateSuffix(node) +
      boxSuffix(node, role) +
      (nodeText ? `: ${nodeText}` : "");
    appendTreeLine(line);

    if (role !== "textbox" && node.text) appendText(node.text);
    for (const child of node.children ?? []) {
      if (typeof child === "string") {
        const childText = normalize(child);
        if (!childText) continue;
        appendTreeLine(`${"  ".repeat(depth + 1)}- text: ${childText}`);
        appendText(child);
      } else {
        visit(child, depth + 1);
      }
    }
  };

  for (const node of nodes) visit(node, 0);
  return { tree, text, truncated };
};
