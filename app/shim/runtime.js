// The bridge between the companion's Node-style code and the page. The page
// fills it in (see app/boot.js) before the companion starts:
//   disk:     desktop fs/childProcess/shell (the installed app), or null (try-it mode, memory only)
//   platform: 'darwin' | 'win32' | ...
//   env:      { HOME, PATH, TMPDIR, DECK_TIME_HOME, ... }
export const rt = (globalThis.__deckRuntime ??= {
  disk: null,
  platform: 'darwin',
  env: {},
  homedir: '/home',
  tmpdir: '/tmp',
  onPersistError: (e) => console.error(e),
});
