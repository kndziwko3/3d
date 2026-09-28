// One definition of "the bottom-sheet layout". The stylesheet switches at the same breakpoint
// (max-width: 960px), and cameras use it to seat the subject clear of the text.
export const sheetQuery = window.matchMedia('(max-width: 960px)');
export const isSheet = () => sheetQuery.matches;
