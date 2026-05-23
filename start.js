const { spawn } = require('child_process');
const path = require('path');

console.log('\x1b[35m%s\x1b[0m', '====================================================');
console.log('\x1b[36m%s\x1b[0m', ' Launching CutterProd & UrumiCam Unified Server');
console.log('\x1b[35m%s\x1b[0m', '====================================================\n');

// 1. Start the CutterProd static server (npx serve src)
const serveProcess = spawn('npx', ['serve', 'src', '-l', '3000'], {
    shell: true,
    stdio: 'inherit'
});

// 2. Start the UrumiCam Python backend server
const urumiPath = path.join(__dirname, 'UrumiCam');
const pyArgs = ['server/app.py'];
if (process.platform === 'win32') {
    pyArgs.push('--mock');
}
const pyProcess = spawn('python', pyArgs, {
    cwd: urumiPath,
    shell: true,
    stdio: 'inherit'
});

// Graceful cleanup on exit
function shutdown() {
    console.log('\n\x1b[31m%s\x1b[0m', ' Shutting down unified servers...');
    
    // Kill processes safely
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', serveProcess.pid, '/f', '/t']);
            spawn('taskkill', ['/pid', pyProcess.pid, '/f', '/t']);
        } else {
            serveProcess.kill('SIGINT');
            pyProcess.kill('SIGINT');
        }
    } catch (e) {
        // Ignore kill errors if already dead
    }
    
    setTimeout(() => {
        process.exit(0);
    }, 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);
