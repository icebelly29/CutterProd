const fs = require('fs');
const lines = fs.readFileSync('src/script.js', 'utf8').split('\n');
// We want to delete from line 41 (index 40) up to line 91 (index 90).
// Wait, line 40 is `import { packMicrosegment } from './BinaryUtils.js';`
// Line 91 is also `import { packMicrosegment } from './BinaryUtils.js';`
// So we can keep lines 0 to 39, and lines 91 onwards.
// 0 to 39 corresponds to lines 1 to 40.
// 91 onwards corresponds to lines 92 onwards.
const newLines = [...lines.slice(0, 40), ...lines.slice(91)];
fs.writeFileSync('src/script.js', newLines.join('\n'));
console.log('Fixed script.js lines');
