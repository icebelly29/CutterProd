import('./src/script.js').then(() => {
    console.log("Parsed correctly!");
}).catch(e => {
    console.error("Failed:", e);
});
