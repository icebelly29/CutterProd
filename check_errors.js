const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

const html = fs.readFileSync('src/index.html', 'utf8');

const virtualConsole = new jsdom.VirtualConsole();
virtualConsole.on("error", () => { console.error("Error:", ...arguments); });
virtualConsole.on("warn", () => { console.warn("Warn:", ...arguments); });
virtualConsole.on("info", () => { console.info("Info:", ...arguments); });
virtualConsole.on("dir", () => { console.dir("Dir:", ...arguments); });

const dom = new JSDOM(html, {
    url: "http://localhost:3000",
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole
});

// Since jsdom might not automatically load relative scripts easily via file:// when not a server,
// let's manually inject the scripts
setTimeout(() => {
    try {
        dom.window.eval(fs.readFileSync('src/Connection.js', 'utf8'));
        dom.window.eval(fs.readFileSync('src/SvgConverter.js', 'utf8'));
        dom.window.eval(fs.readFileSync('src/CanvasEditor.js', 'utf8'));
        dom.window.eval(fs.readFileSync('src/script.js', 'utf8'));
        console.log("All scripts evaluated without immediate crash.");
    } catch(e) {
        console.error("Script evaluation error:", e);
    }
}, 500);
