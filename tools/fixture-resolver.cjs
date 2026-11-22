// Import resolver used only for the lint fixture: its target (modules/bbb/...) intentionally
// does not exist, so resolve relative specifiers to an absolute path without touching disk.
const path = require('node:path');

module.exports = {
  interfaceVersion: 2,
  resolve(source, file) {
    if (!file.includes(`${path.sep}tools${path.sep}lint-fixtures${path.sep}`)) return { found: false };
    if (!source.startsWith('.')) return { found: false };
    return { found: true, path: path.resolve(path.dirname(file), source) };
  },
};
