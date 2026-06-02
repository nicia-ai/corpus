// Left padding for a row at a given depth in a folder tree. Shared by
// the Documents tree and the collection add-browser so the two stay
// visually identical (the rem step is the single source of that).
const TREE_BASE_PAD_REM = 0.75;
const TREE_STEP_REM = 1.25;

export function treeIndent(depth: number): React.CSSProperties {
  return {
    paddingLeft: `${String(TREE_BASE_PAD_REM + depth * TREE_STEP_REM)}rem`,
  };
}
