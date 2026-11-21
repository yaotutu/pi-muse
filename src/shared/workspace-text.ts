const validUnicode = (content: string): boolean => {
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    const next = index + 1 < content.length ? content.charCodeAt(index + 1) : 0;
    if (code > 0xdbff || next < 0xdc00 || next > 0xdfff) return false;
    index++;
  }
  return true;
};

export const isWorkspaceText = (content: string): boolean => !content.includes("\0") && validUnicode(content);
