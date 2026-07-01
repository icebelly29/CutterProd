# SVG Trajectory Converter Modularization

This document outlines the architectural changes made to the `svg-trajectory-converter` package to improve its maintainability and debuggability. 

## Background
Originally, the entire `svg-trajectory-converter` logic was housed in a single, monolithic `index.js` file (over 1,500 lines long). This made it difficult for developers to navigate the codebase, isolate bugs, and understand the distinct responsibilities of different components (e.g., mathematics, string parsing, and binary packing).

To resolve this, the package was refactored into smaller, focused modules.

## Architectural Changes

The source code was split into a new `src/` directory with the following structure:

1. **`src/utils.js`**
   - **Responsibility:** Data manipulation and binary formatting.
   - **Contents:** Contains the standalone functions `crc8` and `packMicrosegment`.

2. **`src/math.js`**
   - **Responsibility:** Core geometry and vector mathematics.
   - **Contents:** Contains the `Vector2` and `CubicBezier` classes.

3. **`src/SvgConverter.js`**
   - **Responsibility:** The main entry point logic, coordinate state management, and SVG parsing.
   - **Contents:** Contains the primary `SvgConverter` class, which imports its dependencies from `utils.js` and `math.js`.

4. **`index.js` (Root)**
   - **Responsibility:** API Preservation.
   - **Contents:** The root `index.js` now acts purely as an entry point. It imports the modules from `src/` and re-exports them exactly as they were in the monolithic version. This ensures that no downstream consumers (like the main CutterProd-microseg app) break due to missing imports.

## Build Process Update

The package supports both ESM (`index.js`) and CommonJS (`index.cjs`) targets. Previously, the `build.js` script stripped ESM syntax from the monolithic file to generate the CJS version.

With the introduction of multiple files, `build.js` was updated to:
1. Read `utils.js`, `math.js`, and `SvgConverter.js` from the `src/` directory.
2. Strip out internal `import` and `export` statements.
3. Concatenate the modules in dependency order.
4. Append the standard `module.exports` statements to generate a bundled `index.cjs` file.

This approach ensures the build process remains lightweight and dependency-free, avoiding the need to install heavy external bundlers like `esbuild` or `rollup`.

## Conclusion
The package is now significantly easier to navigate and debug. Each file has a single, clear responsibility, while the public API remains 100% backward-compatible.
