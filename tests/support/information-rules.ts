export const memoryInformationRules = (notes = "") => ({
  read: async () => notes,
  write: async (text: string) => { notes = text; },
});
