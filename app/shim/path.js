// node:path for the page: POSIX rules, accepting Windows drive paths and
// backslashes, with the PATH delimiter of the computer it runs on.
import posix from 'path-browserify';
import { rt } from './runtime.js';

const fix = (p) => String(p).replace(/\\/g, '/');
const path = {
  ...posix,
  join: (...a) => posix.join(...a.map(fix)),
  resolve: (...a) => posix.resolve(...a.map(fix)),
  normalize: (p) => posix.normalize(fix(p)),
  dirname: (p) => posix.dirname(fix(p)),
  basename: (p, e) => posix.basename(fix(p), e),
  extname: (p) => posix.extname(fix(p)),
  isAbsolute: (p) => /^([a-zA-Z]:)?[\\/]/.test(String(p)),
  relative: (a, b) => posix.relative(fix(a), fix(b)),
  sep: '/',
  get delimiter() {
    return rt.platform === 'win32' ? ';' : ':';
  },
};
path.posix = path;
path.win32 = path;
export default path;
export const { join, resolve, normalize, dirname, basename, extname, isAbsolute, relative, sep } = path;
