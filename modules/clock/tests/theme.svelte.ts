// Test double for the shell's theme seam with a reactive id (a theme switch).
export function reactiveTheme<F>(clockFace: F) {
  let id = $state('one');
  return {
    get id() {
      return id;
    },
    set id(v: string) {
      id = v;
    },
    clockFace,
  };
}
