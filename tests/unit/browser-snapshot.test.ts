import assert from "node:assert/strict";
import test from "node:test";
import {
  NODE_NAME_MAX,
  TEXT_MAX_CHARS,
  TREE_MAX_CHARS,
  TREE_MAX_LINES,
  serializeAriaSnapshot,
} from "../../src/features/browser/snapshot.js";

test("serializes roles, names, refs, states and main-document interactive boxes", () => {
  const result = serializeAriaSnapshot([{
    role: "button",
    name: "  Save \n now  ",
    ref: "e1",
    checked: true,
    disabled: false,
    expanded: true,
    selected: true,
    pressed: true,
    active: true,
    level: 2,
    url: "https://example.test/a?b=1",
    placeholder: "Pick",
    box: { x: 10, y: 20, width: 30, height: 40 },
    text: "  Submit \n now ",
  }, {
    role: "button",
    name: "x".repeat(NODE_NAME_MAX + 20),
  }]);

  assert.equal(
    result.tree,
    `- button "Save now" [ref=e1] [checked=true] [expanded=true] [selected=true] ` +
      `[pressed=true] [active=true] [level=2] [url=https://example.test/a?b=1] ` +
      `[placeholder=Pick] [box=10,20,30,40]: Submit now\n` +
      `- button "${"x".repeat(NODE_NAME_MAX)}"`,
  );
  assert.equal(result.text, "Submit now");
  assert.equal(result.truncated, false);
});

test("serializes string children and projects text in tree order", () => {
  const result = serializeAriaSnapshot([{
    role: "generic",
    text: " parent \n text ",
    children: [
      " child   one ",
      "",
      {
        role: "button",
        name: "Go",
        ref: "e1",
        box: { x: 1, y: 2, width: 3, height: 4 },
        text: "go text",
        children: [" nested "],
      },
    ],
  }]);

  assert.equal(
    result.tree,
    `- generic: parent text\n` +
      `  - text: child one\n` +
      `  - button "Go" [ref=e1] [box=1,2,3,4]: go text\n` +
      `    - text: nested`,
  );
  assert.equal(result.text, "parent text\nchild one\ngo text\nnested");
});

test("omits iframe boxes but keeps main-document pointer boxes", () => {
  const result = serializeAriaSnapshot([{
    role: "button",
    name: "Frame action",
    ref: "f1e2",
    box: { x: 1, y: 2, width: 3, height: 4 },
  }, {
    role: "generic",
    name: "Pointer target",
    ref: "e2",
    cursor: "pointer",
    box: { x: 5.4, y: 6.6, width: 7.2, height: 8.8 },
  }]);

  assert.equal(
    result.tree,
    `- button "Frame action" [ref=f1e2]\n` +
      `- generic "Pointer target" [ref=e2] [box=5,7,7,9]`,
  );
});

test("stops the tree at the line limit", () => {
  const nodes = Array.from({ length: TREE_MAX_LINES + 1 }, () => ({ role: "generic" }));
  const result = serializeAriaSnapshot(nodes);

  assert.equal(result.tree.split("\n").length, TREE_MAX_LINES);
  assert.equal(result.truncated, true);
});

test("stops the tree at the character limit", () => {
  const result = serializeAriaSnapshot([{
    role: "generic",
    children: ["x".repeat(TREE_MAX_CHARS + 100)],
  }]);

  assert.equal(result.tree.length, TREE_MAX_CHARS);
  assert.equal(result.truncated, true);
});

test("keeps textbox values in the tree but out of the text projection", () => {
  const result = serializeAriaSnapshot([{
    role: "textbox",
    name: "Secret",
    ref: "e1",
    text: "hunter2",
    box: { x: 1, y: 2, width: 3, height: 4 },
  }, {
    role: "generic",
    text: "Visible",
    children: ["More"],
  }]);

  assert.match(result.tree, /textbox "Secret" \[ref=e1\] \[box=1,2,3,4\]: hunter2/);
  assert.equal(result.text, "Visible\nMore");
});

test("truncates the text projection and marks the snapshot", () => {
  const result = serializeAriaSnapshot([{
    role: "generic",
    children: ["a".repeat(TEXT_MAX_CHARS + 100)],
  }]);

  assert.equal(result.text.length, TEXT_MAX_CHARS);
  assert.equal(result.truncated, true);
});
