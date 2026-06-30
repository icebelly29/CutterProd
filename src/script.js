import { initFrameGenerator } from './frameGenerator.js';

/**
 * ============================================================================
 *                       MAIN CONTROLLER (THE BRAIN)
 * ============================================================================
 * 
 * This file is the central nervous system of the web application. It connects
 * the muscles (Connection), the eyes (Viewer), and the skin (UI) together.
 * 
 * CORE RESPONSIBILITIES:
 * 1. Application State:
 *    Keeps track of "What is happening right now?"
 *    - Is a job running?
 *    - Is the machine connected?
 *    - What code is loaded?
 * 
 * 2. The "Send-Wait-Send" Loop (Job Execution):
 *    Streaming G-code to a microcontroller isn't like downloading a file. 
 *    We can't send it all at once because the Arduino has very little memory.
 *    
 *    The Protocol:
 *    [Browser] sends Line 1 ---> [ESP32]
 *    [Browser] waits...
 *    [ESP32] executes Line 1 ---> sends "Ack" (Okay, done)
 *    [Browser] receives "Ack" ---> sends Line 2
 * 
 * 3. Event Wiring:
 *    - Listens for button clicks (Start/Stop).
 *    - Listens for drag-and-drop file uploads.
 *    - Listens for manual command typing.
 * ============================================================================
 */

import { log, clearConsole } from './Console.js';
import { updateStatus, setStartButtonState } from './UI.js';
import { MachineConnection } from './Connection.js';
import { setupTabs } from './Tabs.js';
import { renderGCode } from './Viewer.js';
import { handleFile } from './FileHandler.js?v=7';
import { CanvasEditor } from './CanvasEditor.js?v=5';
import { packMicrosegment } from './BinaryUtils.js';

/**
 * Canonical per-axis resolution fallbacks — these MUST match the firmware's
 * machine config (Urumi-Fw/pipeline/stages/config.py): X/Y 160 steps/mm,
 * Z 1200 steps/mm, A 103 steps/deg. Used only when the Settings inputs are
 * empty; the UI Settings remain the live source of truth. Centralised here so
 * the three places that previously hard-coded mismatched defaults (80 / 800 /
 * 92.44) can no longer drift. (Assessment R3 / fix F3.)
 */
const DEFAULT_STEPS = { X: 160, Y: 160, Z: 300, A: 51.6 };
const URUMI_VISION_SERVER_URL = "http://localhost:5000";

/**
 * stampSeq — copies a 26-byte MicroSegment packet, stamps the rolling
 * sequence number into byte [22], and recomputes the CRC-8.
 * Mirrors host/serialise.py:stamp_seq().
 */
function stampSeq(packet, seq) {
    const buf = new Uint8Array(26);
    buf.set(packet);
    buf[22] = seq & 0xFF;
    // Recompute CRC over bytes [0..24]
    let crc = 0;
    for (let i = 0; i < 25; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x01) ? ((crc >> 1) ^ 0x8C) : (crc >> 1);
        }
    }
    buf[25] = crc & 0xFF;
    return buf;
}


/**
 * @file script.js
 * @description MAIN CONTROLLER
 * 
 * This is the "brain" of the application. It brings together all the separate
 * modules (UI, Connection, Files) to make the application work.
 * 
 * CORE LOGIC:
 * 1. It maintains the "State" of the application (is it sending? is it connected?).
 * 2. It handles the "Job Loop": 
 *    - User clicks Start -> Split G-code into lines -> Add to Queue.
 *    - Send Line 1 -> Wait for "Ack" from Machine -> Send Line 2...
 */

// --- Global State ---
// We keep all important variables in one place so it's easy to track what's happening.
const state = {
    gcodeQueue: [],      // Array holding the lines of G-code waiting to be sent
    isSending: false,    // Flag: to check, Are we currently running a job?
    gcode: '',           // Display text of the loaded file (preamble lines joined)
    preamble: [],        // Text setup commands before the binary stream
    binaryPackets: [],   // Pre-built Uint8Array[] from the converter
    packetMeta: [],      // Packet index ranges with SVG method/shape metadata
    editorMirrorsMachineData: true, // False when generated binary queue is hidden from Data Editor
    currentFile: null,   // Holds the raw File object to allow re-conversion
    stepsPerMM: 1.0,     // Conversion factor for Viewer canvas
    lastSentCmd: null,   // Tracks the last sent trajectory line
    currentLine: null,   // Tracks the exact string currently being sent
    wasInterrupted: false, // Flags if the job was stopped midway
    isWaitingForReady: false, // Flag to wait for Pico's "ready" when buffer is full
    resendTimeout: null, // Tracks the timeout for resending commands to prevent spam
    simulatedPathIndex: -1, // Tracks executed path index in simulation and live runs
    suctionMode: 'auto', // Suction mode: 'auto' or 'manual'
    suctionZones: [false, false, false, false, false, false], // Manual selection status for the 6 zones
    suctionAutoActiveZones: [], // Automated active zones calculated from the drawing
    suctionLastSignature: null, // Last suction/servo state actually sent to hardware
    suctionControlEnabled: false, // Master gate: only send suction commands when enabled
    activeRunType: null, // 'job', 'jog', or null
    isPaused: false, // Internal flag to track when the machine is paused for a tool change
    pendingPackets: [],      // Array holding binary packets to send
    binaryStreamOffset: 0,   // Global packet index of the current binary chunk
    base: 0,                 // Go-Back-N oldest unacknowledged packet index
    nextSend: 0,             // Go-Back-N next packet to send
    isBinaryStreaming: false, // Flag: are we currently streaming binary segments?
    lastProgressTime: 0,     // Timestamp of last progress (ACK)
    crcErrors: 0,            // Consecutive CRC errors counter
    nacksCount: 0,           // Total NACKs count
    retriesCount: 0,         // Total Go-Back-N retries count
    goBackTimeout: null,     // Timeout handle for Go-Back-N wait
    isGoBackWaiting: false,  // Is waiting for Go-Back-N settle/backpressure
    stallChecker: null,      // Interval handle for stall detection
    isWaitingForDrain: false, // Are we waiting for the Pico buffer to drain?
    statusPollInterval: null, // Interval handle for status polling
    simTimeout: null         // Simulation timeout handle
};

let wakeLock = null; // Global reference for the Screen Wake Lock API

// --- DOM Elements ---
// References to HTML elements we need to interact with
const editor = document.getElementById('gcodeEditor');
const cmdInput = document.getElementById('cmdInput');
const btnStart = document.getElementById('btnStart');
const dropZone = document.getElementById('dropZone');

// --- Modal Elements ---
const configModal = document.getElementById('configModal');
const btnSettings = document.getElementById('btnSettings');
const btnMeasurePreview = document.getElementById('btnMeasurePreview');
const btnCloseModal = document.getElementById('btnCloseModal');
const segmentLengthInput = document.getElementById('segmentLengthInput');
const segmentLengthSlider = document.getElementById('segmentLengthSlider');
const cuttingSpeedInput = document.getElementById('cuttingSpeedInput');
const cuttingSpeedSlider = document.getElementById('cuttingSpeedSlider');
const zSpeedInput = document.getElementById('zSpeedInput');
const zSpeedSlider = document.getElementById('zSpeedSlider');

// --- Embedded Vision Elements ---
const visionPhotoInput = document.getElementById('visionPhotoInput');
const btnVisionUpload = document.getElementById('btnVisionUpload');
const btnVisionImport = document.getElementById('btnVisionImport');
const btnVisionImportCanvas = document.getElementById('btnVisionImportCanvas');
const btnVisionReset = document.getElementById('btnVisionReset');
const visionStatus = document.getElementById('visionStatus');
const visionSetup = document.getElementById('visionSetup');
const visionReview = document.getElementById('visionReview');
const visionQrCanvas = document.getElementById('visionQrCanvas');
const visionQrSpinner = document.getElementById('visionQrSpinner');
const visionPhoneLink = document.getElementById('visionPhoneLink');
const btnVisionRefreshQr = document.getElementById('btnVisionRefreshQr');
const visionRectifiedPreview = document.getElementById('visionRectifiedPreview');
const visionMaskPreview = document.getElementById('visionMaskPreview');
const visionEdgesPreview = document.getElementById('visionEdgesPreview');
const visionStageEmpty = document.getElementById('visionStageEmpty');
const visionMetaFrame = document.getElementById('visionMetaFrame');
const visionMetaSize = document.getElementById('visionMetaSize');
const visionMetaScale = document.getElementById('visionMetaScale');
const visionMetaError = document.getElementById('visionMetaError');
const visionSimplifySlider = document.getElementById('visionSimplifySlider');
const visionSimplifyValue = document.getElementById('visionSimplifyValue');
const visionMinPathSlider = document.getElementById('visionMinPathSlider');
const visionMinPathValue = document.getElementById('visionMinPathValue');
let latestVisionPayload = null;

// --- Connection Setup ---
// Initialize the WebSocket connection. We provide "callbacks" here.
// Callbacks are functions that run automatically when specific events happen.
const connection = new MachineConnection({
    // When the machine ACK's a binary packet.
    onAck: (seq) => {
        if (!state.isSending) return;

        // Ignore responses that arrive while a Go-Back-N rewind is pending: they
        // are stale (for packets we are about to resend). This mirrors sender.py's
        // _flush_responses() — without it, duplicate-skip ACKs would race `base`
        // ahead of what the Pico actually executed, silently losing motion and
        // falsely reporting completion. (Assessment R1 / fix F1.)
        if (state.isGoBackWaiting) return;

        // The firmware emits exactly one ACK per received packet and processes
        // them strictly in order, so each ACK confirms the oldest in-flight packet
        // (`base`). We deliberately ignore the echoed seq value: after any
        // duplicate-skip ACK it is the Pico's own ACK counter, NOT the packet
        // index. Advancing by one per ACK is exactly what sender.py does
        // (`base += 1`) and keeps `base` aligned with the firmware's expectedSeq.
        if (state.base < state.pendingPackets.length) {
            updatePositionFromPacket(state.pendingPackets[state.base]);
            state.base++;
        }
        state.lastProgressTime = Date.now();
        state.crcErrors = 0; // Reset consecutive CRC errors on progress

        // Render path in viewer (works even if tab is hidden)
        const globalPacketIndex = state.binaryStreamOffset + state.base - 1;
        if (globalPacketIndex > state.simulatedPathIndex) {
            state.simulatedPathIndex = globalPacketIndex;
            updateViewer();
        }

        // Send next window
        sendWindow();
    },

    // When the machine says "nope" (Buffer Full) or has a CRC error
    onNack: (reason) => {
        if (!state.isSending) return;

        // Already rewinding — any further NACKs in this window are stale; the
        // pending go-back will resend everything from `base`. (Fix F1.)
        if (state.isGoBackWaiting) return;

        state.nacksCount++;
        if (reason === 0x03) { // NACK_BAD_MAGIC
            log('FATAL: Pico reported bad magic - aborting.', 'error');
            stopJob();
            return;
        }

        if (reason === 0x01) { // NACK_CRC
            state.crcErrors++;
            if (state.crcErrors > 20) {
                log('FATAL: 20 consecutive CRC errors - aborting.', 'error');
                stopJob();
                return;
            }
            log(`CRC Error (reason 0x01). Rewinding to base ${state.base}...`, 'warning');
            goBack(reason, 5); // 5ms settle delay
        } else if (reason === 0x02) { // NACK_FULL (buffer full backpressure)
            goBack(reason, 50); // 50ms backpressure delay
        }
    },

    // When a text command is acknowledged (e.g. 'ok', 'ack', 'seq reset')
    onAckText: () => {
        if (state.isSending && !state.isBinaryStreaming && !state.isWaitingForDrain) {
            executeNextTextCommand();
        }
    },

    // When the machine is ready after buffer full (legacy text stream callback, ignored in binary streaming)
    onReady: () => { },
    // When the machine says nope (legacy text stream callback, ignored in binary streaming)
    onNope: () => { },

    // If the connection drops mid-job, we must stop everything for safety.
    onDisconnect: stopJob
});

// Register a custom message listener to handle status responses
connection.addMessageListener((msg) => {
    if (msg.includes('state=') && msg.includes('buf=')) {
        handleStatusResponse(msg);
    }
});

// --- Job Control Logic ---

/**
 * Processes status messages from the Pico to monitor buffer drain.
 */
function handleStatusResponse(msg) {
    const match = msg.match(/buf=(\d+)\/(\d+)/);
    if (match) {
        const count = parseInt(match[1]);
        if (state.isWaitingForDrain) {
            log(`Pico execution buffer: ${count} segments remaining.`, 'info');
            if (count === 0) {
                state.isWaitingForDrain = false;
                log('Pico buffer empty. Execution finished physically.', 'success');
                if (state.statusPollInterval) {
                    clearInterval(state.statusPollInterval);
                    state.statusPollInterval = null;
                }

                // Now execute trailing commands or finish the job!
                if (state.gcodeQueue.length > 0) {
                    executeNextTextCommand();
                } else {
                    finishJob();
                }
            }
        }
    }
}

/**
 * Updates the Trajectory Preview canvas with the current simulatedPathIndex.
 * Works even when the Trajectory Preview tab is hidden by temporarily assigning
 * a minimum canvas size if the container's layout is collapsed (display:none gives 0×0).
 */
function updateViewer() {
    const container = document.getElementById('canvasContainer');
    const canvas = document.getElementById('gcodeCanvas');
    if (!canvas || !container) return;

    // Defers to Viewer.js for handling the display:none layout edge-case.
    renderGCode(state.gcode, 'gcodeCanvas', 'canvasContainer', state.stepsPerMM, state.simulatedPathIndex, state.binaryPackets, state.packetMeta);
}

/**
 * Updates the dead-reckoning position display by decoding a binary MicroSegment packet.
 */
function updatePositionFromPacket(packet) {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const dx = view.getInt32(1, true); // Un-invert X from hardware packet
    const dy = view.getInt32(5, true); // Un-invert Y from hardware packet
    const dz = view.getInt32(9, true);
    const da = view.getInt32(13, true);

    jogState.stepX += dx;
    jogState.stepY += dy;
    jogState.stepZ += -dz; // negative steps mean Up, so we negate
    jogState.stepA += da;

    document.getElementById('jogPosX').textContent = jogState.posX.toFixed(2);
    document.getElementById('jogPosY').textContent = jogState.posY.toFixed(2);
    document.getElementById('jogPosZ').textContent = jogState.posZ.toFixed(2);
    document.getElementById('jogPosA').textContent = jogState.posA.toFixed(2);
}

/**
 * Rewinds transmission to base after a delay.
 */
function goBack(reason, delayMs) {
    if (state.goBackTimeout) {
        clearTimeout(state.goBackTimeout);
    }
    state.isGoBackWaiting = true;
    state.goBackTimeout = setTimeout(() => {
        state.goBackTimeout = null;
        state.isGoBackWaiting = false;
        if (state.isSending) {
            state.nextSend = state.base;
            state.retriesCount++;
            sendWindow();
        }
    }, delayMs);
}

/**
 * Sends a sliding window of packets.
 */
function sendWindow() {
    if (!state.isSending || !state.isBinaryStreaming) return;

    const isSimMode = document.getElementById('simModeCheckbox')?.checked;

    if (state.base >= state.pendingPackets.length) {
        log('Binary streaming block completed.', 'success');
        state.isBinaryStreaming = false;
        state.pendingPackets = [];
        executeNextTextCommand();
        return;
    }

    if (isSimMode) {
        simulateBinaryStreaming();
        return;
    }

    if (state.isGoBackWaiting) return;

    const WINDOW_SIZE = 16;
    while (state.nextSend < state.base + WINDOW_SIZE && state.nextSend < state.pendingPackets.length) {
        const packet = state.pendingPackets[state.nextSend];
        connection.send(packet);
        state.nextSend++;
    }

    if (!state.stallChecker) {
        state.lastProgressTime = Date.now();
        state.stallChecker = setInterval(checkStall, 1000);
    }
}

/**
 * Periodically checks for protocol stalls and forces a rewind if needed.
 */
function checkStall() {
    if (!state.isSending || !state.isBinaryStreaming) {
        if (state.stallChecker) {
            clearInterval(state.stallChecker);
            state.stallChecker = null;
        }
        return;
    }

    if (state.isGoBackWaiting) return;

    const timeSinceLastProgress = Date.now() - state.lastProgressTime;
    if (timeSinceLastProgress > 3000) {
        log(`Protocol stall detected (no ACK for 3s). Rewinding to base ${state.base}...`, 'warning');
        state.lastProgressTime = Date.now();
        state.nextSend = state.base;
        state.retriesCount++;
        sendWindow();
    }
}

/**
 * Simulates binary streaming when Sim Mode is enabled.
 */
function simulateBinaryStreaming() {
    if (state.simTimeout) return;

    const simulateNext = () => {
        if (!state.isSending || !state.isBinaryStreaming) {
            state.simTimeout = null;
            return;
        }

        if (state.base < state.pendingPackets.length) {
            const packet = state.pendingPackets[state.base];
            updatePositionFromPacket(packet);

            state.base++;
            state.nextSend = state.base;
            state.lastProgressTime = Date.now();

            const globalPacketIndex = state.binaryStreamOffset + state.base - 1;
            if (globalPacketIndex > state.simulatedPathIndex) {
                state.simulatedPathIndex = globalPacketIndex;
                updateViewer();
            }

            state.simTimeout = setTimeout(simulateNext, 50);
        } else {
            state.simTimeout = null;
            log('Binary streaming block completed (simulated).', 'success');
            state.isBinaryStreaming = false;
            state.pendingPackets = [];
            executeNextTextCommand();
        }
    };

    state.simTimeout = setTimeout(simulateNext, 50);
}

function makeBinaryStreamCommand(start, end) {
    return `__BINARY_STREAM__:${start}:${end}`;
}

function parseBinaryStreamCommand(command) {
    if (command === '__BINARY_STREAM__') {
        return { start: 0, end: Math.max(0, state.binaryPackets.length - 1) };
    }
    if (!command.startsWith('__BINARY_STREAM__:')) return null;
    const [, startText, endText] = command.split(':');
    const start = parseInt(startText, 10);
    const end = parseInt(endText, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
    return { start, end: Math.min(end, state.binaryPackets.length - 1) };
}

function getMethodGroup(method) {
    return String(method || '').toLowerCase() === 'crease' ? 'crease' : 'work';
}

function buildBinaryStreamCommands(packets, packetMeta = []) {
    if (!packets?.length) return [];
    const sortedMeta = (packetMeta || [])
        .filter(meta => Number.isFinite(meta.start) && Number.isFinite(meta.end) && meta.end >= meta.start)
        .sort((a, b) => a.start - b.start);

    if (!sortedMeta.length) {
        return [makeBinaryStreamCommand(0, packets.length - 1)];
    }

    const runs = [];
    sortedMeta.forEach(meta => {
        const group = getMethodGroup(meta.method);
        const start = Math.max(0, meta.start);
        const end = Math.min(packets.length - 1, meta.end);
        const last = runs[runs.length - 1];
        if (last && last.group === group && start <= last.end + 1) {
            last.end = Math.max(last.end, end);
        } else {
            runs.push({ group, start, end });
        }
    });

    if (!runs.length) return [makeBinaryStreamCommand(0, packets.length - 1)];
    if (runs[0].start > 0) {
        runs.unshift({ group: 'setup', start: 0, end: runs[0].start - 1 });
    }
    const lastRun = runs[runs.length - 1];
    if (lastRun.end < packets.length - 1) {
        lastRun.end = packets.length - 1;
    }

    const hasCrease = runs.some(run => run.group === 'crease');
    if (!hasCrease) {
        return runs.map(run => makeBinaryStreamCommand(run.start, run.end));
    }

    const commands = [];
    let beforeCreasePauseInserted = false;
    let afterCreasePauseInserted = false;

    runs.forEach((run, index) => {
        if (run.group === 'crease' && !beforeCreasePauseInserted) {
            commands.push('PAUSE_FOR_TOOL_CHANGE:Install creasing tool');
            beforeCreasePauseInserted = true;
        }

        if (run.group !== 'crease' && beforeCreasePauseInserted && !afterCreasePauseInserted) {
            commands.push('PAUSE_FOR_TOOL_CHANGE:Switch back to cutting/scoring tool');
            afterCreasePauseInserted = true;
        }

        commands.push(makeBinaryStreamCommand(run.start, run.end));

        const nextRun = runs[index + 1];
        if (run.group === 'crease' && !nextRun && !afterCreasePauseInserted) {
            commands.push('PAUSE_FOR_TOOL_CHANGE:Creasing complete; change tool before finishing');
            afterCreasePauseInserted = true;
        }
    });

    return commands;
}

function buildJobQueue() {
    const textCommands = state.preamble
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith(';'))
        .filter(l => !(state.binaryPackets?.length && l.startsWith('PAUSE_FOR_TOOL_CHANGE')));

    if (!state.binaryPackets?.length) {
        return textCommands;
    }

    return [
        ...textCommands,
        ...buildBinaryStreamCommands(state.binaryPackets, state.packetMeta)
    ];
}

function formatMethodLabel(method) {
    const normalized = String(method || 'thru_cut').toLowerCase();
    if (normalized === 'crease') return 'Crease';
    if (normalized === 'off_base' || normalized === 'score' || normalized === 'scoring') return 'Score';
    return 'Cut';
}

function formatPacketRange(start, end) {
    return start === end ? `packet ${start + 1}` : `packets ${start + 1}-${end + 1}`;
}

function buildDataEditorSummary(result, stepsPerMM = 1.0) {
    const preamble = result.preamble || [];
    const packets = result.packets || [];
    const packetMeta = result.packetMeta || [];
    const setupCommands = preamble
        .map(line => line.trim())
        .filter(line => line && !line.startsWith(';') && !line.startsWith('PAUSE_FOR_TOOL_CHANGE'));
    const streamCommands = buildBinaryStreamCommands(packets, packetMeta);
    const methodStats = new Map();

    packetMeta.forEach(meta => {
        const key = formatMethodLabel(meta.method);
        const current = methodStats.get(key) || { shapes: 0, packets: 0 };
        current.shapes += 1;
        current.packets += Math.max(0, (meta.end ?? -1) - (meta.start ?? 0) + 1);
        methodStats.set(key, current);
    });

    const lines = [
        'JOB PLAN',
        '========',
        '',
        `Total motion packets: ${packets.length}`,
        `Drawable paths: ${packetMeta.length || 'unknown'}`,
        `Preview scale: ${Number(stepsPerMM).toFixed(2)} steps/mm`,
        ''
    ];

    if (methodStats.size > 0) {
        lines.push('Pass Summary', '------------');
        for (const [label, stats] of methodStats.entries()) {
            lines.push(`- ${label}: ${stats.shapes} path${stats.shapes === 1 ? '' : 's'}, ${stats.packets} packet${stats.packets === 1 ? '' : 's'}`);
        }
        lines.push('');
    }

    if (setupCommands.length > 0) {
        lines.push('Setup Commands', '--------------');
        setupCommands.forEach(command => lines.push(`- ${command}`));
        lines.push('');
    }

    lines.push('Run Order', '---------');
    if (!streamCommands.length) {
        lines.push('- No binary motion chunks were generated.');
    } else {
        streamCommands.forEach((command, index) => {
            if (command.startsWith('PAUSE_FOR_TOOL_CHANGE')) {
                const message = command.includes(':')
                    ? command.slice(command.indexOf(':') + 1).trim()
                    : 'Change tool';
                lines.push(`${index + 1}. TOOL CHANGE: ${message}`);
                return;
            }

            const range = parseBinaryStreamCommand(command);
            if (!range) {
                lines.push(`${index + 1}. ${command}`);
                return;
            }

            const methods = new Set();
            let shapeCount = 0;
            packetMeta.forEach(meta => {
                if (meta.end < range.start || meta.start > range.end) return;
                methods.add(formatMethodLabel(meta.method));
                shapeCount += 1;
            });
            const methodText = methods.size ? Array.from(methods).join(', ') : 'Motion';
            lines.push(`${index + 1}. ${methodText}: ${formatPacketRange(range.start, range.end)} (${range.end - range.start + 1} packets, ${shapeCount || 'unknown'} paths)`);
        });
    }

    lines.push(
        '',
        'Notes',
        '-----',
        '- Use Trajectory Preview to visually inspect the motion path.',
        '- Tool-change pauses happen during the run, between the listed chunks.',
        '',
        'Raw Packets',
        '-----------'
    );

    if (packets && packets.length > 0) {
        // Limit output to prevent freezing the browser with huge files
        const maxDisplay = Math.min(packets.length, 5000);
        for (let i = 0; i < maxDisplay; i++) {
            const pkt = packets[i];
            if (pkt.length === 26) {
                const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
                const magic = view.getUint8(0);
                if (magic === 0xAB) {
                    const dx = view.getInt32(1, true);
                    const dy = view.getInt32(5, true);
                    const dz = view.getInt32(9, true);
                    const da = view.getInt32(13, true);
                    const interval = view.getUint32(17, true);
                    const flags = view.getUint8(21);
                    const seq = view.getUint8(22);
                    lines.push(`[${i + 1}] seq=${seq} dx=${dx} dy=${dy} dz=${dz} da=${da} dt=${interval} flags=${flags}`);
                } else {
                    lines.push(`[${i + 1}] Invalid Magic`);
                }
            }
        }
        if (packets.length > maxDisplay) {
            lines.push(`... (and ${packets.length - maxDisplay} more packets hidden for performance)`);
        }
    } else {
        lines.push('- No packets generated.');
    }

    return lines.join('\n');
}

/**
 * START JOB
 * Called when the user clicks "Start Cutting".
 * It prepares the G-code and starts the sending loop.
 */
function startJob() {
    if (!state.preamble.length && !state.binaryPackets?.length) {
        log('No trajectory loaded. Please load an SVG or G-code file first.', 'error');
        return;
    }

    // --- SAFE RETRACT INJECTION (binary packet prepended to binaryPackets) ---
    if (state.wasInterrupted && state.binaryPackets?.length) {
        const zStepsPerMM = getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z);
        const zUpStep = Math.round(12 * zStepsPerMM);
        const zSpeed = parseFloat(document.getElementById('zSpeedInput')?.value) || 4;
        const stepVz = Math.max(1, Math.round(zSpeed * zStepsPerMM));
        const interval = Math.max(1, Math.min(Math.round(150_000_000 / stepVz), 150_000_000));
        const retractPkt = stampSeq(packMicrosegment(0, 0, -zUpStep, 0, interval, 0x01, 0), 0);
        state.binaryPackets = [retractPkt, ...state.binaryPackets];
        state.packetMeta = (state.packetMeta || []).map(meta => ({
            ...meta,
            start: meta.start + 1,
            end: meta.end + 1
        }));
        log(`Injected Safe Retract (Z-Up) as binary packet`, 'info');
    }

    state.gcodeQueue = buildJobQueue();

    if (state.gcodeQueue.length === 0) {
        log('No commands to send.', 'error');
        return;
    }

    state.activeRunType = 'job';

    // --- SUCTION BED INJECTION (before the first binary stream chunk) ---
    if (shouldRunSuction()) {
        const suctionCommands = buildSuctionCommandSequence(true);
        const sentinelIdx = state.gcodeQueue.findIndex(cmd => parseBinaryStreamCommand(cmd));
        if (sentinelIdx > -1) {
            state.gcodeQueue.splice(sentinelIdx, 0, ...suctionCommands);
        } else {
            state.gcodeQueue.unshift(...suctionCommands);
        }
        state.suctionLastSignature = suctionCommands.join('|');
        log(`Injected Suction Settings: ${suctionCommands.join(' | ')}`, 'info');
    }

    state.wasInterrupted = false;
    state.simulatedPathIndex = -1;

    log(`Starting Job: ${state.gcodeQueue.length} lines.`, 'success');

    // 2. Update State
    state.isSending = true;
    setStartButtonState(true); // Visual change (Turn button Red/Stop)

    // F6: Request Wake Lock to prevent browser from throttling JS/WebSerial
    if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen')
            .then(lock => { wakeLock = lock; log('Wake Lock active.', 'info'); })
            .catch(err => log('Wake Lock blocked (requires HTTPS or localhost).', 'warning'));
    }

    // 3. Kickoff
    executeNextTextCommand();
}

function resumeJob() {
    state.isPaused = false;
    state.isSending = true;
    setStartButtonState(true, false);
    log('▶️ Resuming job...', 'success');
    if (state.isBinaryStreaming) {
        sendWindow();
    } else {
        executeNextTextCommand();
    }
}

/**
 * STOP JOB
 * Called by user or on error. Clears the queue immediately.
 */
function stopJob() {
    if (!state.isSending && !state.isPaused) return; // Prevent duplicate logs if already stopped

    const hadActiveRun = shouldRunSuction();
    state.activeRunType = null;
    state.isSending = false;
    state.isPaused = false;
    state.gcodeQueue = []; // Delete all remaining commands
    state.wasInterrupted = true; // Mark that it was stopped mid-way

    // Clear all timers and intervals
    if (state.resendTimeout) {
        clearTimeout(state.resendTimeout);
        state.resendTimeout = null;
    }
    if (state.goBackTimeout) {
        clearTimeout(state.goBackTimeout);
        state.goBackTimeout = null;
    }
    if (state.stallChecker) {
        clearInterval(state.stallChecker);
        state.stallChecker = null;
    }
    if (state.statusPollInterval) {
        clearInterval(state.statusPollInterval);
        state.statusPollInterval = null;
    }
    if (state.simTimeout) {
        clearTimeout(state.simTimeout);
        state.simTimeout = null;
    }

    // F6: Release Wake Lock
    if (wakeLock) {
        wakeLock.release().then(() => { wakeLock = null; });
    }
    state.isBinaryStreaming = false;
    state.isWaitingForDrain = false;
    state.isGoBackWaiting = false;

    // Send stop command to machine immediately
    if (connection.connected) {
        connection.send('stop', true);
    }

    // Shut off suction immediately for safety and power efficiency
    if (connection.connected && (hadActiveRun || state.suctionLastSignature !== 'OFF')) {
        sendSuctionCommands(false, false);
    }
    updateSuctionUI();

    log('Job Stopped. Position saved for safe retract on restart. Suction deactivated.', 'error');
    setStartButtonState(false); // Turn button back to Green/Start
}

/**
 * EXECUTE NEXT TEXT COMMAND
 * Sends the next non-motion or setup command sequentially.
 */
function executeNextTextCommand() {
    if (!state.isSending) return;

    if (state.gcodeQueue.length > 0) {
        const nextCmd = state.gcodeQueue[0];

        // When we hit a __BINARY_STREAM__ sentinel, launch the binary pipeline
        const binaryRange = parseBinaryStreamCommand(nextCmd);
        if (binaryRange) {
            state.gcodeQueue.shift();
            startBinaryStreaming(
                state.binaryPackets.slice(binaryRange.start, binaryRange.end + 1),
                binaryRange.start
            );
            return;
        }

        if (nextCmd === '__JOG_BINARY_STREAM__') {
            state.gcodeQueue.shift();
            startBinaryStreaming(state.jogPackets);
            return;
        }

        // WAIT_MS:<ms> sentinel — pause before sending the next command.
        // Used after 'enable all 1' so the Pico finishes its enable sequence
        // before we send suction/stream commands (avoids "Command queue full").
        if (nextCmd.startsWith('WAIT_MS:')) {
            state.gcodeQueue.shift();
            const ms = parseInt(nextCmd.split(':')[1]) || 200;
            setTimeout(() => { if (state.isSending) executeNextTextCommand(); }, ms);
            return;
        }

        state.currentLine = state.gcodeQueue.shift();

        if (state.currentLine.startsWith('PAUSE_FOR_TOOL_CHANGE')) {
            const message = state.currentLine.includes(':')
                ? state.currentLine.slice(state.currentLine.indexOf(':') + 1).trim()
                : 'Please change the tool';
            log(`PAUSED FOR TOOL CHANGE. ${message}, then click Resume Job.`, 'warning');
            state.isSending = false;
            state.isPaused = true;
            setStartButtonState(false, true);
            return;
        }

        const isSimMode = document.getElementById('simModeCheckbox')?.checked;
        if (isSimMode) {
            log(`[SIM] ${state.currentLine}`, 'tx');
            setTimeout(() => {
                if (!state.isSending) return;
                log('PICO: ok', 'success');
                executeNextTextCommand();
            }, 50);
        } else {
            connection.send(state.currentLine);
            log(`> ${state.currentLine}`, 'tx');
        }
    } else {
        const isSimMode = document.getElementById('simModeCheckbox')?.checked;
        if (isSimMode || !connection.connected) {
            finishJob();
        } else {
            log('Waiting for Pico motion buffer to drain...', 'info');
            state.isWaitingForDrain = true;
            connection.send('status');
            state.statusPollInterval = setInterval(() => {
                if (state.isSending && state.isWaitingForDrain) {
                    connection.send('status');
                } else {
                    clearInterval(state.statusPollInterval);
                    state.statusPollInterval = null;
                }
            }, 250);
        }
    }
}

/**
 * START BINARY STREAMING
 * Takes a pre-built Uint8Array[] and starts Go-Back-N transmission.
 * @param {Uint8Array[]} packets - Pre-built 26-byte binary packets from SvgConverter.
 */
function startBinaryStreaming(packets, packetOffset = 0) {
    if (!packets || packets.length === 0) {
        log('Binary stream: no packets to send.', 'warning');
        executeNextTextCommand();
        return;
    }

    // Stamp rolling sequence numbers (0..255 wrap)
    state.pendingPackets = packets.map((pkt, i) => stampSeq(pkt, i & 0xFF));
    state.binaryStreamOffset = packetOffset;

    state.base = 0;
    state.nextSend = 0;
    state.isBinaryStreaming = true;
    state.lastProgressTime = Date.now();
    state.crcErrors = 0;

    log(`Starting binary stream of ${state.pendingPackets.length} segments...`, 'info');

    const isSimMode = document.getElementById('simModeCheckbox')?.checked;
    if (isSimMode) {
        simulateBinaryStreaming();
    } else {
        connection.send('seqreset');
        sendWindow();
    }
}

/**
 * FINISH JOB
 * Clean up after the last command is sent.
 */
function finishJob() {
    const completedRunType = state.activeRunType;
    const hadActiveRun = shouldRunSuction();
    state.isSending = false;
    state.activeRunType = null;

    // Jobs always finish with suction off; jog/park can restore manual suction state.
    const shouldRestoreManualSuction = completedRunType !== 'job' && shouldRunSuction();
    if (connection.connected) {
        if (shouldRestoreManualSuction || hadActiveRun || state.suctionLastSignature !== 'OFF') {
            sendSuctionCommands(false, shouldRestoreManualSuction);
        }
    }
    updateSuctionUI();

    if (completedRunType === 'jog') {
        log('Jog move complete.', 'success');
    } else {
        log('Job Complete. Suction deactivated.', 'success');
    }

    // F6: Release Wake Lock
    if (wakeLock) {
        wakeLock.release().then(() => { wakeLock = null; });
    }

    setStartButtonState(false);
}

// --- Event Listeners ---

// Wake Lock Re-Acquisition on Tab Visibility Change
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible' && state.isSending) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            log('Wake Lock re-acquired.', 'info');
        } catch (err) {
            log('Wake Lock re-request failed.', 'warning');
        }
    }
});

// --- Panel Toggle Logic ---
const suctionPanelHeader = document.getElementById('suctionPanelHeader');
const suctionPanelBody = document.getElementById('suctionPanelBody');
const suctionPanelToggle = document.getElementById('suctionPanelToggle');

if (suctionPanelHeader && suctionPanelBody) {
    suctionPanelHeader.addEventListener('click', (e) => {
        // Prevent toggle if clicking on the status text or other interactive elements
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;

        if (suctionPanelBody.style.display === 'none') {
            suctionPanelBody.style.display = 'flex';
            if (suctionPanelToggle) suctionPanelToggle.style.transform = 'rotate(180deg)';
        } else {
            suctionPanelBody.style.display = 'none';
            if (suctionPanelToggle) suctionPanelToggle.style.transform = 'rotate(0deg)';
        }
    });
}

// 1. Start/Stop Button Logic
btnStart.addEventListener('click', () => {
    if (state.isSending) {
        stopJob();
    } else if (state.isPaused) {
        resumeJob();
    } else {
        startJob();
    }
});

// 2. Manual Command Input (The text box at the bottom)
const cmdHistory = [];
let cmdHistoryIndex = -1;

function handleManualSend() {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;

    cmdHistory.push(cmd);
    cmdHistoryIndex = cmdHistory.length;

    // Special command to clear the screen
    if (cmd.toLowerCase() === 'clear' || cmd.toLowerCase() === '/clear') {
        clearConsole();
        cmdInput.value = '';
        return;
    }

    connection.send(cmd, true); // true = Log this as a manual command
    cmdInput.value = '';
}

// Wire up the manual input buttons/keys
document.getElementById('btnClear').addEventListener('click', clearConsole);
document.getElementById('btnRun').addEventListener('click', handleManualSend);

// Quick Actions
const btnToggleMotors = document.getElementById('btnToggleMotors');
if (btnToggleMotors) {
    btnToggleMotors.addEventListener('click', () => {
        const isEnabled = btnToggleMotors.dataset.enabled === 'true';
        if (isEnabled) {
            connection.send('disable all', true);
            btnToggleMotors.dataset.enabled = 'false';
            btnToggleMotors.textContent = 'Enable Motors';
        } else {
            connection.send('enable all', true);
            btnToggleMotors.dataset.enabled = 'true';
            btnToggleMotors.textContent = 'Disable Motors';
        }
    });
}

const btnToggleKnife = document.getElementById('btnToggleKnife');
if (btnToggleKnife) {
    btnToggleKnife.addEventListener('click', () => {
        const isEnabled = btnToggleKnife.dataset.enabled === 'true';
        if (isEnabled) {
            connection.send('knife 0', true);
            btnToggleKnife.dataset.enabled = 'false';
            btnToggleKnife.textContent = 'Knife ON';
        } else {
            connection.send('knife 1', true);
            btnToggleKnife.dataset.enabled = 'true';
            btnToggleKnife.textContent = 'Knife OFF';
        }
    });
}

const btnPingAll = document.getElementById('btnPingAll');
if (btnPingAll) {
    btnPingAll.addEventListener('click', async () => {
        if (!connection.connected) {
            log('Ping All: Not connected to machine.', 'error');
            return;
        }

        // Disable button during the ping process to prevent spamming
        btnPingAll.disabled = true;
        const originalText = btnPingAll.textContent;
        btnPingAll.textContent = 'Pinging...';

        log('Starting sequential Ping All (Nodes 1 to 4)...', 'info');
        const nodes = [1, 2, 3, 4];

        for (const node of nodes) {
            if (!connection.connected) {
                log('Ping All: Connection lost.', 'error');
                break;
            }

            log(`Sending: ping ${node}`, 'info');
            connection.send(`ping ${node}`, true);

            // Wait for response or timeout (e.g. 1.5 seconds)
            await new Promise((resolve) => {
                let resolved = false;
                const timeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        log(`Node ${node} ping timeout (no response).`, 'warning');
                        connection.removeMessageListener(listener);
                        resolve();
                    }
                }, 1500); // 1.5 second timeout is robust for WebSerial

                const listener = (msg) => {
                    const lowerMsg = msg.toLowerCase();
                    // We look for a response matching this node, e.g. "pong 1", "pong", "ok", "ack" or direct acknowledgment
                    if (lowerMsg.includes('pong') || lowerMsg.includes('ack') || lowerMsg.includes('ok') || lowerMsg.includes(`ping ${node}`)) {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            connection.removeMessageListener(listener);
                            log(`Node ${node} responded.`, 'success');
                            // Small delay before next ping for visual clarity
                            setTimeout(resolve, 200);
                        }
                    }
                };
                connection.addMessageListener(listener);
            });
        }

        log('Ping All sequence completed.', 'success');
        btnPingAll.disabled = false;
        btnPingAll.textContent = originalText;
    });
}

const btnPingNode = document.getElementById('btnPingNode');
const pingNodeId = document.getElementById('pingNodeId');
if (btnPingNode && pingNodeId) {
    btnPingNode.addEventListener('click', () => {
        const id = pingNodeId.value.trim();
        if (id) {
            connection.send(`ping ${id}`, true);
        } else {
            log('Please enter a Node ID to ping.', 'error');
        }
    });
}

cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        handleManualSend();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault(); // Prevent cursor from moving to start
        if (cmdHistory.length > 0 && cmdHistoryIndex > 0) {
            cmdHistoryIndex--;
            cmdInput.value = cmdHistory[cmdHistoryIndex];
        }
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (cmdHistory.length > 0 && cmdHistoryIndex < cmdHistory.length - 1) {
            cmdHistoryIndex++;
            cmdInput.value = cmdHistory[cmdHistoryIndex];
        } else {
            cmdHistoryIndex = cmdHistory.length;
            cmdInput.value = '';
        }
    }
});

// 3. Reconnect on Badge Click or Connect Button
// If user clicks the "Disconnected" red badge, try to reconnect.
document.getElementById('statusBadge').addEventListener('click', () => {
    state.suctionLastSignature = null;
    connection.connect();
});
document.getElementById('btnConnect').addEventListener('click', () => {
    if (connection.connected) {
        state.suctionLastSignature = null;
        connection.disconnect();
    } else {
        state.suctionLastSignature = null;
        connection.connect();
    }
});

// 4. Sync Editor changes
// When user types in the editor, update our global variable so the preview knows.
editor.addEventListener('input', () => {
    if (!state.editorMirrorsMachineData) return;
    state.gcode = editor.value;
    state.suctionAutoActiveZones = calculateActiveZones(state.gcode, state.binaryPackets);
    updateSuctionUI();
});

// --- File Handling Setup ---

// Callback: What to do when a file is processed and ready?
// result: { preamble: string[], packets: Uint8Array[], packetMeta?: object[] }
function onGCodeReady(result, stepsPerMM = 1.0) {
    // Accept either the new {preamble, packets} object or a legacy plain string
    if (typeof result === 'string') {
        result = { preamble: result.split('\n').filter(l => l.trim()), packets: [] };
    }
    state.preamble = result.preamble || [];
    state.binaryPackets = result.packets || [];
    state.packetMeta = result.packetMeta || [];
    state.gcode = state.preamble.join('\n');
    state.stepsPerMM = stepsPerMM;
    state.editorMirrorsMachineData = state.binaryPackets.length === 0;
    editor.readOnly = !state.editorMirrorsMachineData;
    if (state.editorMirrorsMachineData) {
        editor.value = state.gcode;
        editor.placeholder = 'Trajectory Data will appear here...';
    } else {
        editor.value = buildDataEditorSummary(result, stepsPerMM);
        editor.placeholder = 'Job plan will appear here...';
    }
    state.wasInterrupted = false;
    state.lastSentCmd = null;

    // Automatically calculate bed zones where shapes are active
    state.suctionAutoActiveZones = calculateActiveZones(state.gcode, state.binaryPackets);
    updateSuctionUI();

    // Enable start button if connected or in simulation mode
    const isSim = document.getElementById('simModeCheckbox')?.checked;
    if (connection.connected || isSim) {
        btnStart.disabled = false;
    }
}

// --- Initialization ---

// ── Draw Canvas Editor Setup ─────────────────────────────────────────────────
// The CanvasEditor needs the same viewport metrics that Viewer computes so that
// its machine-mm ↔ canvas-px transforms match exactly. We keep a shared live
// object and update it whenever the draw tab opens.
const drawViewState = { scale: 1, offsetX: 0, offsetY: 0, bedW: 600, bedH: 750 };

const drawCanvasEl = document.getElementById('drawCanvas');
const drawContainer = document.getElementById('drawCanvasContainer');
let canvasEditor = null;

if (drawCanvasEl) {
    canvasEditor = new CanvasEditor(drawCanvasEl, drawViewState);
}

// Recompute viewport metrics (mirrors the Viewer math)
let hasInitializedView = false;
function updateDrawViewMetrics() {
    const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 630;
    const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 780;

    if (!drawContainer || !drawCanvasEl) return;
    const rect = drawContainer.getBoundingClientRect();

    let resized = false;
    if (drawCanvasEl.width !== rect.width) { drawCanvasEl.width = rect.width; resized = true; }
    if (drawCanvasEl.height !== rect.height) { drawCanvasEl.height = rect.height; resized = true; }

    if (!hasInitializedView || resized) {
        const padding = 40;
        const availW = drawCanvasEl.width - padding * 2;
        const availH = drawCanvasEl.height - padding * 2;
        const scale = Math.min(availW / bedW, availH / bedH);

        const offsetX = drawCanvasEl.width / 2 - (bedW / 2) * scale;
        const offsetY = drawCanvasEl.height / 2 - (bedH / 2) * scale;

        Object.assign(drawViewState, { scale, offsetX, offsetY, bedW, bedH });
        hasInitializedView = true;
    } else {
        drawViewState.bedW = bedW;
        drawViewState.bedH = bedH;
    }
}

// Draw bridge passed to Tabs so it can activate/deactivate editor on tab switch
const drawBridge = {
    activate() {
        updateDrawViewMetrics();
        if (canvasEditor) {
            canvasEditor.activate();
            canvasEditor.draw();
        }
    },
    deactivate() {
        if (canvasEditor) canvasEditor.deactivate();
    }
};

// Add listener for Method Toggle
document.querySelectorAll('.method-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const method = e.currentTarget.dataset.value;

        // Update UI active state
        document.querySelectorAll('.method-toggle-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');

        // Update hidden input for compatibility
        const hiddenInput = document.getElementById('drawShapeMethod');
        if (hiddenInput) hiddenInput.value = method;

        if (canvasEditor) canvasEditor.setCurrentMethod(method);
    });
});




// Keyboard shortcuts for tools (only when draw panel is visible)
window.addEventListener('keydown', e => {
    if (!document.getElementById('drawPanel') ||
        document.getElementById('drawPanel').classList.contains('hidden')) return;
    if (document.activeElement.tagName === 'INPUT' ||
        document.activeElement.tagName === 'TEXTAREA') return;
    const map = { 'v': 'select', 'p': 'pencil', 'l': 'line', 'r': 'rect', 'e': 'circle', 'x': 'eraser', 'b': 'bezier' };
    const tool = map[e.key.toLowerCase()];
    if (tool) {
        selectDrawTool(tool);
    }
    // Ctrl+Z undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && canvasEditor) {
        if (canvasEditor.shapes.length > 0) {
            canvasEditor.shapes.pop();
            canvasEditor.draw();
        }
    }
    // Ctrl+G group
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'g' && canvasEditor) {
        e.preventDefault();
        canvasEditor.groupNodes();
    }
    // Ctrl+Shift+G ungroup
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g' && canvasEditor) {
        e.preventDefault();
        canvasEditor.ungroupNodes();
    }
});

function selectDrawTool(toolName) {
    if (canvasEditor) canvasEditor.setTool(toolName);
    document.querySelectorAll('.draw-tool-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.draw-tool-btn[data-tool="${toolName}"]`);
    if (btn) btn.classList.add('active');
}

// Wire all palette tool buttons
document.querySelectorAll('.draw-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => selectDrawTool(btn.dataset.tool));
});

// Stroke width
const drawStrokeInput = document.getElementById('drawStrokeWidth');
if (drawStrokeInput) {
    drawStrokeInput.addEventListener('input', () => {
        if (canvasEditor) canvasEditor.setStrokeWidth(parseFloat(drawStrokeInput.value) || 1.5);
    });
}

// Eraser radius
const drawEraserInput = document.getElementById('drawEraserRadius');
if (drawEraserInput) {
    drawEraserInput.addEventListener('input', () => {
        if (canvasEditor) canvasEditor.setEraserRadius(parseFloat(drawEraserInput.value) || 5);
    });
}

const drawPageFrameSelect = document.getElementById('drawPageFrame');
const drawPageOrientationSelect = document.getElementById('drawPageOrientation');
function syncDrawPageFrame() {
    if (!canvasEditor) return;
    canvasEditor.setPageFrame(
        drawPageFrameSelect?.value || 'none',
        drawPageOrientationSelect?.value || 'portrait'
    );
}
drawPageFrameSelect?.addEventListener('change', syncDrawPageFrame);
drawPageOrientationSelect?.addEventListener('change', syncDrawPageFrame);

// Clear All
document.getElementById('btnDrawClear')?.addEventListener('click', () => {
    if (canvasEditor) {
        canvasEditor.clearAll();
        // Re-draw bed background
        drawBridge.activate();
    }
});

// Skeletonize
document.getElementById('btnDrawSkeletonize')?.addEventListener('click', () => {
    if (canvasEditor) {
        log('Skeletonizing drawn shapes...', 'info');
        canvasEditor.skeletonize();
        log('Skeletonization complete.', 'success');
    }
});

// Undo
document.getElementById('btnDrawUndo')?.addEventListener('click', () => {
    if (canvasEditor && canvasEditor.shapes.length > 0) {
        canvasEditor.shapes.pop();
        canvasEditor.draw();
    }
});

// Group / Ungroup Buttons
document.getElementById('btnDrawGroup')?.addEventListener('click', () => {
    if (canvasEditor) canvasEditor.groupNodes();
});

document.getElementById('btnDrawUngroup')?.addEventListener('click', () => {
    if (canvasEditor) canvasEditor.ungroupNodes();
});

// Send to Cutter – export drawn shapes as SVG and push through handleFile
document.getElementById('btnDrawSend')?.addEventListener('click', () => {
    if (!canvasEditor || !canvasEditor.hasShapes) {
        log('No drawn shapes to send.', 'error');
        return;
    }
    const svgText = canvasEditor.exportAsSVG();
    const virtualFile = new File([svgText], 'canvas_drawing.svg', { type: 'image/svg+xml' });
    log('Converting drawn shapes to trajectory...', 'info');
    handleFile(virtualFile, onGCodeReady, window.switchTab);
});

// Import SVG to CanvasEditor
document.getElementById('btnDrawImport')?.addEventListener('click', () => {
    document.getElementById('drawFileInput')?.click();
});

document.getElementById('drawFileInput')?.addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    const file = e.target.files[0];
    if (canvasEditor) {
        const text = await file.text();
        canvasEditor.importSVG(text);
        log('SVG imported into drawing editor.', 'success');
    }
    e.target.value = ''; // Reset
});

// Also re-draw bed bg whenever bed size changes
['bedWidthInput', 'bedHeightInput'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
        if (!document.getElementById('drawPanel')?.classList.contains('hidden')) {
            drawBridge.activate();
        }
    });
});

// Setup the Tab clicking logic (Preview vs Editor vs Draw)
setupTabs(() => state, drawBridge);

// --- Embedded Vision Import ---
function visionAssetUrl(pathOrUrl, serverUrl = URUMI_VISION_SERVER_URL) {
    if (!pathOrUrl) return "";
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    const cleanPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    return `${serverUrl}${cleanPath}`;
}

function setVisionStatus(message, kind = "info") {
    if (!visionStatus) return;

    if (kind === 'loading') {
        visionStatus.innerHTML = `<span style="display:inline-block; margin-right:8px; width:12px; height:12px; border:2px solid var(--text-muted); border-top-color:var(--text-primary); border-radius:50%; animation:spin 1s linear infinite;"></span>${message}`;
    } else {
        visionStatus.textContent = message;
    }

    visionStatus.classList.toggle('success', kind === 'success');
    visionStatus.classList.toggle('error', kind === 'error');
}

function setVisionStage(stage) {
    const isReview = stage === "review";
    visionSetup?.classList.toggle('hidden', isReview);
    visionReview?.classList.toggle('hidden', !isReview);
}

function setVisionMeta(payload) {
    if (visionMetaFrame) visionMetaFrame.textContent = payload?.frame_name || "-";
    if (visionMetaSize) {
        const width = payload?.physical_width;
        const height = payload?.physical_height;
        visionMetaSize.textContent = width && height ? `${width} x ${height} mm` : "-";
    }
    if (visionMetaScale) {
        const dpi = payload?.dpi ? `${payload.dpi} DPI` : "";
        const dpm = payload?.dots_per_mm ? `${Number(payload.dots_per_mm).toFixed(1)} px/mm` : "";
        visionMetaScale.textContent = [dpi, dpm].filter(Boolean).join(' / ') || "-";
    }
    if (visionMetaError) {
        visionMetaError.textContent = Number.isFinite(payload?.error_mm) ? `${payload.error_mm.toFixed(3)} mm` : "-";
    }
}

function updateVisionPreviews(payload) {
    const stamp = Date.now();
    if (visionRectifiedPreview && payload?.image_url) {
        visionRectifiedPreview.src = visionAssetUrl(payload.image_url);
    }
    if (visionMaskPreview && payload?.mask_image_url) {
        visionMaskPreview.src = visionAssetUrl(payload.mask_image_url);
    }
    if (visionEdgesPreview) {
        const edgePath = payload?.edges_image_url || `/uploads/rectified_edges.png?t=${stamp}`;
        visionEdgesPreview.src = visionAssetUrl(edgePath);
    }
    if (visionStageEmpty) {
        visionStageEmpty.classList.toggle('hidden', !!payload?.image_url);
    }
    setVisionMeta(payload);
}

function applyVisionPayload(payload, message = "Photo processed. Review it, then import the trace.") {
    latestVisionPayload = payload;
    updateVisionPreviews(payload);
    setVisionStage("review");
    if (btnVisionImport) btnVisionImport.disabled = false;
    if (btnVisionImportCanvas) btnVisionImportCanvas.disabled = false;
    setVisionStatus(message, "success");
}

async function generateVisionQrCode() {
    if (!visionQrCanvas || !visionQrSpinner) return;

    visionQrSpinner.textContent = "Generating...";
    visionQrSpinner.classList.remove('hidden');
    visionQrCanvas.style.opacity = '0.3';

    try {
        const res = await fetch(`${URUMI_VISION_SERVER_URL}/api/network-info`);
        const data = await res.json();
        if (!res.ok || !data.url) {
            throw new Error("Could not get mobile upload link");
        }

        if (visionPhoneLink) {
            visionPhoneLink.href = data.url;
            visionPhoneLink.textContent = data.url;
        }

        visionQrCanvas.width = 160;
        visionQrCanvas.height = 160;

        if (window.QRious) {
            new window.QRious({
                element: visionQrCanvas,
                value: data.url,
                size: 160,
                background: '#111827',
                foreground: '#3b82f6',
                level: 'H'
            });
        } else {
            const ctx = visionQrCanvas.getContext('2d');
            ctx.clearRect(0, 0, 160, 160);
            ctx.fillStyle = '#111827';
            ctx.fillRect(0, 0, 160, 160);
            ctx.fillStyle = '#e5e7eb';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(data.url, 80, 80);
        }

        visionQrCanvas.style.opacity = '1';
        visionQrSpinner.classList.add('hidden');
        setVisionStatus("Waiting for a bed photo.");
    } catch (err) {
        visionQrSpinner.textContent = "QR failed";
        if (visionPhoneLink) {
            visionPhoneLink.removeAttribute('href');
            visionPhoneLink.textContent = "Phone link unavailable";
        }
        setVisionStatus(err.message, "error");
    }
}

function loadVisionImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load ${src}`));
        img.src = src;
    });
}

function getVisionNumericControl(input, fallback) {
    const value = parseFloat(input?.value);
    return Number.isFinite(value) ? value : fallback;
}

function syncVisionTuningOutputs() {
    if (visionSimplifyValue) {
        visionSimplifyValue.value = getVisionNumericControl(visionSimplifySlider, 5).toString();
    }
    if (visionMinPathValue) {
        visionMinPathValue.value = getVisionNumericControl(visionMinPathSlider, 16).toString();
    }
}

function formatSvgNum(value) {
    return Number(value.toFixed(2));
}

function pointDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += pointDistance(points[i - 1], points[i]);
    }
    return total;
}

function dedupePolyline(points, minSegmentLength = 1.25) {
    if (points.length <= 1) return points.slice();
    const filtered = [points[0]];
    for (let i = 1; i < points.length; i++) {
        if (pointDistance(filtered[filtered.length - 1], points[i]) >= minSegmentLength) {
            filtered.push(points[i]);
        }
    }
    if (filtered.length === 1 && points.length > 1) {
        filtered.push(points[points.length - 1]);
    }
    return filtered;
}

function pointToSegmentDistance(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) return pointDistance(point, start);
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
    const proj = { x: start.x + t * dx, y: start.y + t * dy };
    return pointDistance(point, proj);
}

function simplifyRdp(points, epsilon) {
    if (points.length <= 2) return points.slice();

    let maxDistance = 0;
    let index = -1;
    const start = points[0];
    const end = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
        const candidateDistance = pointToSegmentDistance(points[i], start, end);
        if (candidateDistance > maxDistance) {
            maxDistance = candidateDistance;
            index = i;
        }
    }

    if (maxDistance <= epsilon || index === -1) {
        return [start, end];
    }

    const left = simplifyRdp(points.slice(0, index + 1), epsilon);
    const right = simplifyRdp(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
}

function getPolylineBounds(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
    }
    return { minX, minY, maxX, maxY };
}

function isClosedPolyline(points) {
    if (points.length < 4) return false;
    const bounds = getPolylineBounds(points);
    const diag = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    return pointDistance(points[0], points[points.length - 1]) <= Math.max(3, diag * 0.08);
}

function simplifyVisionPolyline(points) {
    const simplifyStrength = getVisionNumericControl(visionSimplifySlider, 5);
    const dedupeDistance = Math.max(0.35, Math.min(1.25, simplifyStrength * 0.12));
    const deduped = dedupePolyline(points, dedupeDistance);
    if (deduped.length <= 2) return deduped;

    const bounds = getPolylineBounds(deduped);
    const diag = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const closed = isClosedPolyline(deduped);
    const epsilon = closed
        ? Math.max(0.55, Math.min(3.2, diag * (0.0025 + simplifyStrength * 0.0009)))
        : Math.max(0.65, Math.min(8, diag * (0.004 + simplifyStrength * 0.0016) + deduped.length * 0.003));
    const simplified = simplifyRdp(deduped, epsilon);
    if (simplified.length < 2) return deduped;
    if (closed && simplified.length < 8 && deduped.length >= 8) return deduped;
    return simplified;
}

function pointsToLineSvgPath(points) {
    if (!points.length) return "";
    return points.map((point, index) => {
        const prefix = index === 0 ? "M" : "L";
        return `${prefix} ${formatSvgNum(point.x)},${formatSvgNum(point.y)}`;
    }).join(' ');
}

const VISION_PATH_STYLES = {
    thru_cut: { stroke: "#3b82f6" },
    score: { stroke: "#ef4444" },
    crease: { stroke: "#22c55e" }
};

function buildVisionTraceSvg(groupedPaths, width, height) {
    let svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}px" height="${height}px">\n`;
    for (const method of ["thru_cut", "score", "crease"]) {
        if (!groupedPaths[method]?.length) continue;
        const d = groupedPaths[method].map(pointsToLineSvgPath).filter(Boolean).join(' ');
        if (!d) continue;
        svgText += `  <path d="${d}" fill="none" stroke="${VISION_PATH_STYLES[method].stroke}" stroke-width="1" vector-effect="non-scaling-stroke" data-method="${method}"/>\n`;
    }
    return `${svgText}</svg>`;
}

function getBedSizeMM() {
    return {
        bedW: parseFloat(document.getElementById('bedWidthInput')?.value) || 630,
        bedH: parseFloat(document.getElementById('bedHeightInput')?.value) || 780
    };
}

function hasUsableVisionMeta(meta) {
    return Number.isFinite(Number(meta?.dots_per_mm)) && Number(meta.dots_per_mm) > 0
        && Number.isFinite(Number(meta?.physical_width)) && Number(meta.physical_width) > 0
        && Number.isFinite(Number(meta?.physical_height)) && Number(meta.physical_height) > 0;
}

function visionPixelPointToCanvasSvgPoint(point, meta, bedW, bedH) {
    const dotsPerMM = Number(meta.dots_per_mm);
    const physicalHeight = Number(meta.physical_height);
    const machineX = point.x / dotsPerMM;
    const machineY = physicalHeight - (point.y / dotsPerMM);
    return {
        x: machineX,
        y: bedH - machineY
    };
}

function buildVisionCanvasSvg(groupedPaths, urumiMeta) {
    const { bedW, bedH } = getBedSizeMM();
    let svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bedW} ${bedH}" width="${bedW}mm" height="${bedH}mm" data-source="canvas">\n`;
    for (const method of ["thru_cut", "score", "crease"]) {
        if (!groupedPaths[method]?.length) continue;
        const convertedPaths = groupedPaths[method]
            .map(points => points.map(point => visionPixelPointToCanvasSvgPoint(point, urumiMeta, bedW, bedH)))
            .map(pointsToLineSvgPath)
            .filter(Boolean);
        if (!convertedPaths.length) continue;
        svgText += `  <path d="${convertedPaths.join(' ')}" fill="none" stroke="${VISION_PATH_STYLES[method].stroke}" stroke-width="1" vector-effect="non-scaling-stroke" data-method="${method}"/>\n`;
    }
    return `${svgText}</svg>`;
}

function parseSimpleSvgPathPoints(pathData) {
    const numbers = pathData.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
    const points = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
        points.push({ x: parseFloat(numbers[i]), y: parseFloat(numbers[i + 1]) });
    }
    return points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return { h: h * 360, s, l };
}

function getNeighborhoodInkColor(cData, x, y) {
    let minL = 1.1;
    let bestRgb = { r: 255, g: 255, b: 255 };
    const rx = Math.round(x);
    const ry = Math.round(y);

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const px = Math.max(0, Math.min(cData.width - 1, rx + dx));
            const py = Math.max(0, Math.min(cData.height - 1, ry + dy));
            const idx = (py * cData.width + px) * 4;
            const r = cData.data[idx];
            const g = cData.data[idx + 1];
            const b = cData.data[idx + 2];
            const maxVal = Math.max(r, g, b) / 255;
            const minVal = Math.min(r, g, b) / 255;
            const l = (maxVal + minVal) / 2;

            if (l < minL) {
                minL = l;
                bestRgb = { r, g, b };
            }
        }
    }
    return bestRgb;
}

function classifyHsl(h, s) {
    if (s < 0.12) return "neutral";
    if (h >= 335 || h < 25) return "red";
    if (h >= 75 && h < 160) return "green";
    if (h >= 170 && h < 265) return "blue";
    return "unknown";
}

function classifyVisionPolyline(points, colorData) {
    const votes = { red: 0, blue: 0, green: 0, neutral: 0, unknown: 0 };
    const sampleCount = Math.min(20, points.length);
    for (let i = 0; i < sampleCount; i++) {
        const idx = Math.floor(i * (points.length - 1) / (sampleCount - 1 || 1));
        const point = points[idx];
        const rgb = getNeighborhoodInkColor(colorData, point.x, point.y);
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        votes[classifyHsl(hsl.h, hsl.s)]++;
    }

    let dominantColor = "neutral";
    let maxVotes = -1;
    for (const color in votes) {
        if (votes[color] > maxVotes) {
            maxVotes = votes[color];
            dominantColor = color;
        }
    }

    if (dominantColor === "red") return "score";
    if (dominantColor === "green") return "crease";
    return "thru_cut";
}

function normalizeVisionMethod(method) {
    if (method === "off_base" || method === "score" || method === "scoring") return "score";
    if (method === "crease" || method === "thru_cut") return method;
    return null;
}

async function processUrumiVisionAssets({ serverUrl = URUMI_VISION_SERVER_URL, payload = latestVisionPayload, sourceLabel = "Vision", destination = "trajectory" } = {}) {
    const stamp = Date.now();
    const svgUrl = visionAssetUrl(payload?.edges_svg_url || `/uploads/rectified_edges.svg?t=${stamp}`, serverUrl);
    const colorUrl = visionAssetUrl(payload?.image_url || `/uploads/rectified_bed.png?t=${stamp}`, serverUrl);
    const [svgRes, colorImg] = await Promise.all([
        fetch(svgUrl),
        loadVisionImage(colorUrl)
    ]);

    if (!svgRes.ok) {
        throw new Error(`Failed to load detected trace (${svgRes.status})`);
    }

    const svgSource = await svgRes.text();
    const parsedSvg = new DOMParser().parseFromString(svgSource, "image/svg+xml");
    const sourcePaths = Array.from(parsedSvg.querySelectorAll('path'));
    if (!sourcePaths.length) {
        throw new Error("No detected paths found in rectified_edges.svg");
    }

    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = colorImg.width;
    colorCanvas.height = colorImg.height;
    const colorCtx = colorCanvas.getContext('2d');
    colorCtx.drawImage(colorImg, 0, 0);
    const colorData = colorCtx.getImageData(0, 0, colorImg.width, colorImg.height);

    const minPathLength = getVisionNumericControl(visionMinPathSlider, 16);
    const groupedPaths = {
        thru_cut: [],
        score: [],
        crease: []
    };
    let keptCount = 0;
    let sourcePointCount = 0;
    let simplifiedPointCount = 0;

    for (const path of sourcePaths) {
        const points = parseSimpleSvgPathPoints(path.getAttribute('d') || '');
        sourcePointCount += points.length;
        if (points.length < 2 || polylineLength(points) < minPathLength) continue;

        const simplifiedPoints = simplifyVisionPolyline(points);
        if (simplifiedPoints.length < 2 || polylineLength(simplifiedPoints) < minPathLength) continue;

        const method = normalizeVisionMethod(path.getAttribute('data-method')) || classifyVisionPolyline(points, colorData);
        groupedPaths[method].push(simplifiedPoints);
        simplifiedPointCount += simplifiedPoints.length;
        keptCount++;
    }

    if (!keptCount) {
        throw new Error("All detected paths were filtered out. Lower Min path and try importing again.");
    }

    const width = payload?.width_px || colorImg.width;
    const height = payload?.height_px || colorImg.height;
    const svgText = buildVisionTraceSvg(groupedPaths, width, height);
    let urumiMeta = null;
    if (payload?.dots_per_mm) {
        urumiMeta = {
            dots_per_mm: payload.dots_per_mm,
            physical_width: payload.physical_width,
            physical_height: payload.physical_height
        };
    } else {
        try {
            const metaRes = await fetch(visionAssetUrl(`/uploads/metadata.json?t=${stamp}`, serverUrl));
            if (metaRes.ok) {
                const meta = await metaRes.json();
                urumiMeta = {
                    dots_per_mm: meta.dots_per_mm,
                    physical_width: meta.physical_width,
                    physical_height: meta.physical_height
                };
            }
        } catch (err) { }
    }

    if (destination === "canvas") {
        if (!canvasEditor) throw new Error("Drawing canvas is not ready.");
        if (!hasUsableVisionMeta(urumiMeta)) {
            throw new Error("Missing scanner scale data, so the trace cannot be placed accurately in Draw.");
        }

        const { bedW, bedH } = getBedSizeMM();
        drawViewState.bedW = bedW;
        drawViewState.bedH = bedH;
        const canvasSvgText = buildVisionCanvasSvg(groupedPaths, urumiMeta);
        canvasEditor.importSVG(canvasSvgText);
        selectDrawTool('select');
        if (window.switchTab) {
            window.switchTab('draw');
        }
        drawBridge.activate();
        log(`${sourceLabel}: added ${keptCount}/${sourcePaths.length} traced paths to the drawing canvas.`, "success");
        setVisionStatus(`Added ${keptCount} paths to Draw. ${sourcePointCount} points simplified to ${simplifiedPointCount}.`, "success");
        return;
    }

    const virtualFile = new File([svgText], "vision_trace.svg", { type: "image/svg+xml" });
    log(`${sourceLabel}: imported ${keptCount}/${sourcePaths.length} paths, simplified ${sourcePointCount} points to ${simplifiedPointCount}.`, "success");
    setVisionStatus(`Imported ${keptCount} paths. ${sourcePointCount} points simplified to ${simplifiedPointCount}.`, "success");
    handleFile(virtualFile, onGCodeReady, window.switchTab, urumiMeta);

    if (window.switchTab) {
        window.switchTab('gcode-preview');
    }
}

syncVisionTuningOutputs();
visionSimplifySlider?.addEventListener('input', syncVisionTuningOutputs);
visionMinPathSlider?.addEventListener('input', syncVisionTuningOutputs);
btnVisionRefreshQr?.addEventListener('click', generateVisionQrCode);

btnVisionUpload?.addEventListener('click', () => visionPhotoInput?.click());

visionPhotoInput?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
        setVisionStatus("Preparing image...", "loading");
        if (btnVisionUpload) btnVisionUpload.disabled = true;
        if (btnVisionImport) btnVisionImport.disabled = true;
        if (btnVisionImportCanvas) btnVisionImportCanvas.disabled = true;

        // Resize image on client to speed up upload
        const resizedBlob = await new Promise((resolve, reject) => {
            const imgUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(imgUrl);
                const MAX_DIM = 2048;
                let { width, height } = img;
                if (width > MAX_DIM || height > MAX_DIM) {
                    if (width > height) {
                        height = Math.round((height * MAX_DIM) / width);
                        width = MAX_DIM;
                    } else {
                        width = Math.round((width * MAX_DIM) / height);
                        height = MAX_DIM;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob(blob => {
                    if (blob) resolve(blob);
                    else reject(new Error("Failed to process image blob."));
                }, 'image/jpeg', 0.85);
            };
            img.onerror = () => {
                URL.revokeObjectURL(imgUrl);
                reject(new Error("Failed to load image."));
            };
            img.src = imgUrl;
        });

        setVisionStatus("Uploading and rectifying photo...", "loading");
        const form = new FormData();
        form.append("image", resizedBlob, file.name || "capture.jpg");
        const res = await fetch(`${URUMI_VISION_SERVER_URL}/api/method2/upload`, {
            method: "POST",
            body: form
        });
        const payload = await res.json();
        if (!res.ok || !payload.success) {
            throw new Error(payload?.message || `Upload failed (${res.status})`);
        }

        applyVisionPayload(payload, `Ready: ${payload.width_px} x ${payload.height_px}px, ${Number(payload.dots_per_mm || 0).toFixed(2)} px/mm.`);
        log("Vision photo processed. Review the previews, then import the trace.", "success");
    } catch (err) {
        setVisionStatus(err.message, "error");
        log(`Vision upload failed: ${err.message}`, "error");
    } finally {
        if (btnVisionUpload) btnVisionUpload.disabled = false;
        event.target.value = "";
    }
});

btnVisionImport?.addEventListener('click', async () => {
    try {
        setVisionStatus("Importing simplified trace...", "loading");
        if (btnVisionImport) btnVisionImport.disabled = true;
        if (btnVisionImportCanvas) btnVisionImportCanvas.disabled = true;
        await processUrumiVisionAssets({ payload: latestVisionPayload });
    } catch (err) {
        setVisionStatus(err.message, "error");
        log(`Vision import failed: ${err.message}`, "error");
    } finally {
        if (btnVisionImport) btnVisionImport.disabled = !latestVisionPayload;
        if (btnVisionImportCanvas) btnVisionImportCanvas.disabled = !latestVisionPayload;
    }
});

btnVisionImportCanvas?.addEventListener('click', async () => {
    try {
        setVisionStatus("Adding trace to drawing canvas...", "loading");
        if (btnVisionImport) btnVisionImport.disabled = true;
        if (btnVisionImportCanvas) btnVisionImportCanvas.disabled = true;
        await processUrumiVisionAssets({ payload: latestVisionPayload, destination: "canvas" });
    } catch (err) {
        setVisionStatus(err.message, "error");
        log(`Vision draw import failed: ${err.message}`, "error");
    } finally {
        if (btnVisionImport) btnVisionImport.disabled = !latestVisionPayload;
        if (btnVisionImportCanvas) btnVisionImportCanvas.disabled = !latestVisionPayload;
    }
});

btnVisionReset?.addEventListener('click', () => {
    latestVisionPayload = null;
    if (btnVisionImport) btnVisionImport.disabled = true;
    if (btnVisionImportCanvas) btnVisionImportCanvas.disabled = true;
    if (visionRectifiedPreview) visionRectifiedPreview.removeAttribute('src');
    if (visionMaskPreview) visionMaskPreview.removeAttribute('src');
    if (visionEdgesPreview) visionEdgesPreview.removeAttribute('src');
    if (visionStageEmpty) visionStageEmpty.classList.remove('hidden');
    setVisionMeta(null);
    setVisionStage("setup");
    setVisionStatus("Waiting for a bed photo.");
    generateVisionQrCode();
});

setVisionStage("setup");
generateVisionQrCode();

// --- Real-time UrumiCam SVG Push Listener ---
function setupUrumiCamPushListener() {
    const serverUrl = URUMI_VISION_SERVER_URL;

    // Dynamic Socket.IO client library loader
    function loadSocketIO() {
        return new Promise((resolve) => {
            if (window.io) return resolve(window.io);
            const script = document.createElement('script');
            script.src = `${serverUrl}/socket.io/socket.io.js`;
            script.onload = () => resolve(window.io);
            script.onerror = () => {
                // Fallback CDN
                const fallback = document.createElement('script');
                fallback.src = "https://cdn.socket.io/4.7.2/socket.io.min.js";
                fallback.onload = () => resolve(window.io);
                fallback.onerror = () => console.log("[UrumiCam Bridge] Socket.IO failed to load.");
                document.head.appendChild(fallback);
            };
            document.head.appendChild(script);
        });
    }

    loadSocketIO().then((io) => {
        if (!io) return;
        const socket = io(serverUrl, { reconnection: true, transports: ['websocket'] });

        socket.on('connect', () => {
            console.log("[UrumiCam Bridge] Connected to UrumiCam background listener.");
        });

        socket.on('bed_rectified', (payload) => {
            applyVisionPayload(payload, "Phone upload received. Review it, then import the trace.");
            log("Vision photo received from mobile upload.", "success");
            if (window.switchTab) {
                window.switchTab('vision');
            }
        });

        socket.on('import_svg_in_cutter', async (data) => {
            try {
                if (data && data.error) throw new Error(data.error);
                log("[UrumiCam Bridge] Received push; importing simplified trace in UrumiCutter.", "info");
                await processUrumiVisionAssets({ serverUrl, sourceLabel: "UrumiCam Bridge" });
            } catch (e) {
                log(`UrumiCam bridge import failed: ${e.message}`, "error");
            }
            return;

            log("[UrumiCam Bridge] Received real-time push from UrumiCam! Tracing skeleton...", "info");

            try {
                if (data && data.error) throw new Error(data.error);

                // Fetch both the true binary mask and the rectified color bed photo
                const maskUrl = `${serverUrl}/uploads/rectified_mask.png?t=${Date.now()}`;
                const colorUrl = `${serverUrl}/uploads/rectified_bed.png?t=${Date.now()}`;

                const maskImg = new Image();
                maskImg.crossOrigin = "Anonymous";

                const colorImg = new Image();
                colorImg.crossOrigin = "Anonymous";

                const loadMaskPromise = new Promise((resolve, reject) => {
                    maskImg.onload = resolve;
                    maskImg.onerror = () => reject(new Error("Failed to load rectified_mask.png"));
                    maskImg.src = maskUrl;
                });

                const loadColorPromise = new Promise((resolve, reject) => {
                    colorImg.onload = resolve;
                    colorImg.onerror = () => reject(new Error("Failed to load rectified_bed.png"));
                    colorImg.src = colorUrl;
                });

                await Promise.all([loadMaskPromise, loadColorPromise]);

                if (!window.TraceSkeleton) {
                    throw new Error("TraceSkeleton library not loaded");
                }

                // Draw mask to offscreen canvas to get ImageData
                const maskCanvas = document.createElement('canvas');
                maskCanvas.width = maskImg.width;
                maskCanvas.height = maskImg.height;
                const maskCtx = maskCanvas.getContext('2d');
                maskCtx.drawImage(maskImg, 0, 0);
                const maskData = maskCtx.getImageData(0, 0, maskImg.width, maskImg.height);

                // Draw color image to offscreen canvas to get ImageData
                const colorCanvas = document.createElement('canvas');
                colorCanvas.width = colorImg.width;
                colorCanvas.height = colorImg.height;
                const colorCtx = colorCanvas.getContext('2d');
                colorCtx.drawImage(colorImg, 0, 0);
                const colorData = colorCtx.getImageData(0, 0, colorImg.width, colorImg.height);

                // Tracing algorithm expects a flat binary array
                const o = maskData.data;
                const a = new Array(maskImg.width * maskImg.height);
                for (let i = 0, j = 0; i < o.length; i += 4, j++) {
                    a[j] = o[i] > 127 ? 1 : 0;
                }

                // trace(data, width, height, chunk_size)
                const result = window.TraceSkeleton.trace(a, maskImg.width, maskImg.height, 3);

                // Helpers for color classification
                function rgbToHsl(r, g, b) {
                    r /= 255; g /= 255; b /= 255;
                    const max = Math.max(r, g, b), min = Math.min(r, g, b);
                    let h, s, l = (max + min) / 2;

                    if (max === min) {
                        h = s = 0;
                    } else {
                        const d = max - min;
                        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                        switch (max) {
                            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                            case g: h = (b - r) / d + 2; break;
                            case b: h = (r - g) / d + 4; break;
                        }
                        h /= 6;
                    }
                    return { h: h * 360, s, l };
                }

                function getNeighborhoodInkColor(cData, x, y) {
                    let minL = 1.1;
                    let bestRgb = { r: 255, g: 255, b: 255 };
                    const rx = Math.round(x);
                    const ry = Math.round(y);

                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const px = Math.max(0, Math.min(cData.width - 1, rx + dx));
                            const py = Math.max(0, Math.min(cData.height - 1, ry + dy));
                            const idx = (py * cData.width + px) * 4;
                            const r = cData.data[idx];
                            const g = cData.data[idx + 1];
                            const b = cData.data[idx + 2];

                            const maxVal = Math.max(r, g, b) / 255;
                            const minVal = Math.min(r, g, b) / 255;
                            const l = (maxVal + minVal) / 2;

                            if (l < minL) {
                                minL = l;
                                bestRgb = { r, g, b };
                            }
                        }
                    }
                    return bestRgb;
                }

                function classifyHsl(h, s, l) {
                    if (s < 0.12) {
                        return "neutral"; // black, grey, white
                    }
                    if (h >= 335 || h < 25) {
                        return "red";
                    }
                    if (h >= 75 && h < 160) {
                        return "green";
                    }
                    if (h >= 170 && h < 265) {
                        return "blue";
                    }
                    return "unknown";
                }

                function dist(a, b) {
                    return Math.hypot(b.x - a.x, b.y - a.y);
                }

                function formatSvgNum(value) {
                    return Number(value.toFixed(2));
                }

                function toPointList(poly) {
                    return poly.map(([x, y]) => ({ x, y }));
                }

                function dedupePolyline(points, minSegmentLength = 1.25) {
                    if (points.length <= 1) return points.slice();
                    const filtered = [points[0]];
                    for (let i = 1; i < points.length; i++) {
                        if (dist(filtered[filtered.length - 1], points[i]) >= minSegmentLength) {
                            filtered.push(points[i]);
                        }
                    }
                    if (filtered.length === 1 && points.length > 1) {
                        filtered.push(points[points.length - 1]);
                    }
                    return filtered;
                }

                function pointToSegmentDistance(point, start, end) {
                    const dx = end.x - start.x;
                    const dy = end.y - start.y;
                    if (dx === 0 && dy === 0) {
                        return dist(point, start);
                    }
                    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
                    const proj = { x: start.x + t * dx, y: start.y + t * dy };
                    return dist(point, proj);
                }

                function simplifyRdp(points, epsilon) {
                    if (points.length <= 2) return points.slice();

                    let maxDistance = 0;
                    let index = -1;
                    const start = points[0];
                    const end = points[points.length - 1];

                    for (let i = 1; i < points.length - 1; i++) {
                        const candidateDistance = pointToSegmentDistance(points[i], start, end);
                        if (candidateDistance > maxDistance) {
                            maxDistance = candidateDistance;
                            index = i;
                        }
                    }

                    if (maxDistance <= epsilon || index === -1) {
                        return [start, end];
                    }

                    const left = simplifyRdp(points.slice(0, index + 1), epsilon);
                    const right = simplifyRdp(points.slice(index), epsilon);
                    return left.slice(0, -1).concat(right);
                }

                function getPolylineBounds(points) {
                    let minX = Infinity;
                    let minY = Infinity;
                    let maxX = -Infinity;
                    let maxY = -Infinity;
                    for (const point of points) {
                        if (point.x < minX) minX = point.x;
                        if (point.y < minY) minY = point.y;
                        if (point.x > maxX) maxX = point.x;
                        if (point.y > maxY) maxY = point.y;
                    }
                    return { minX, minY, maxX, maxY };
                }

                function simplifyTracePolyline(poly) {
                    const points = dedupePolyline(toPointList(poly));
                    if (points.length <= 2) {
                        return points;
                    }

                    const bounds = getPolylineBounds(points);
                    const diag = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
                    const epsilon = Math.max(1.5, Math.min(8, diag * 0.015 + points.length * 0.006));
                    const simplified = simplifyRdp(points, epsilon);

                    if (simplified.length < 2) {
                        return points;
                    }
                    return simplified;
                }

                function pointsToSvgPath(points) {
                    if (!points.length) return "";
                    if (points.length === 1) {
                        return `M ${formatSvgNum(points[0].x)},${formatSvgNum(points[0].y)}`;
                    }
                    if (points.length === 2) {
                        return `M ${formatSvgNum(points[0].x)},${formatSvgNum(points[0].y)} L ${formatSvgNum(points[1].x)},${formatSvgNum(points[1].y)}`;
                    }

                    const tension = 0.85;
                    let d = `M ${formatSvgNum(points[0].x)},${formatSvgNum(points[0].y)}`;

                    for (let i = 0; i < points.length - 1; i++) {
                        const p0 = points[i - 1] || points[i];
                        const p1 = points[i];
                        const p2 = points[i + 1];
                        const p3 = points[i + 2] || p2;

                        const c1 = {
                            x: p1.x + ((p2.x - p0.x) * tension) / 6,
                            y: p1.y + ((p2.y - p0.y) * tension) / 6
                        };
                        const c2 = {
                            x: p2.x - ((p3.x - p1.x) * tension) / 6,
                            y: p2.y - ((p3.y - p1.y) * tension) / 6
                        };

                        d += ` C ${formatSvgNum(c1.x)},${formatSvgNum(c1.y)} ${formatSvgNum(c2.x)},${formatSvgNum(c2.y)} ${formatSvgNum(p2.x)},${formatSvgNum(p2.y)}`;
                    }

                    return d;
                }

                let thruCutPaths = [];
                let offBasePaths = [];
                let creasePaths = [];

                for (const poly of result.polylines) {
                    if (poly.length < 10) continue; // Filter out tiny noise specs

                    // Sample up to 20 points along the polyline to determine dominant color
                    let votes = { red: 0, blue: 0, green: 0, neutral: 0, unknown: 0 };
                    const numSamples = Math.min(20, poly.length);
                    for (let i = 0; i < numSamples; i++) {
                        const idx = Math.floor(i * (poly.length - 1) / (numSamples - 1 || 1));
                        const pt = poly[idx];
                        const rgb = getNeighborhoodInkColor(colorData, pt[0], pt[1]);
                        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
                        const cls = classifyHsl(hsl.h, hsl.s, hsl.l);
                        votes[cls]++;
                    }

                    // Majority vote
                    let maxVotes = -1;
                    let dominantColor = "neutral";
                    for (const color in votes) {
                        if (votes[color] > maxVotes) {
                            maxVotes = votes[color];
                            dominantColor = color;
                        }
                    }

                    // Map ink color to cutting method
                    let method = "thru_cut";
                    if (dominantColor === "blue") {
                        method = "thru_cut";
                    } else if (dominantColor === "red") {
                        method = "score";
                    } else if (dominantColor === "green") {
                        method = "crease";
                    } else {
                        method = "thru_cut"; // black/neutral ink defaults to thru_cut
                    }

                    const simplifiedPoints = simplifyTracePolyline(poly);
                    if (simplifiedPoints.length < 2) continue;

                    const pathD = pointsToSvgPath(simplifiedPoints);

                    if (method === "thru_cut") {
                        thruCutPaths.push(pathD);
                    } else if (method === "score" || method === "off_base") {
                        offBasePaths.push(pathD);
                    } else if (method === "crease") {
                        creasePaths.push(pathD);
                    }
                }

                let svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${maskImg.width} ${maskImg.height}" width="${maskImg.width}px" height="${maskImg.height}px">\n`;
                if (thruCutPaths.length > 0) {
                    svgText += `  <path d="${thruCutPaths.join(' ')}" fill="none" stroke="#3b82f6" stroke-width="1" vector-effect="non-scaling-stroke" data-method="thru_cut"/>\n`;
                }
                if (offBasePaths.length > 0) {
                    svgText += `  <path d="${offBasePaths.join(' ')}" fill="none" stroke="#ef4444" stroke-width="1" vector-effect="non-scaling-stroke" data-method="score"/>\n`;
                }
                if (creasePaths.length > 0) {
                    svgText += `  <path d="${creasePaths.join(' ')}" fill="none" stroke="#22c55e" stroke-width="1" vector-effect="non-scaling-stroke" data-method="crease"/>\n`;
                }
                svgText += `</svg>`;

                const virtualFile = new File([svgText], "skeleton_trace.svg", { type: "image/svg+xml" });

                let urumiMeta = null;
                try {
                    const metaRes = await fetch(`${serverUrl}/uploads/metadata.json?t=${Date.now()}`);
                    if (metaRes.ok) {
                        const meta = await metaRes.json();
                        urumiMeta = {
                            dots_per_mm: meta.dots_per_mm,
                            physical_width: meta.physical_width,
                            physical_height: meta.physical_height
                        };
                    }
                } catch (err) { }

                log(`Skeletonization complete: Extracted ${result.polylines.length} polylines.`, "success");
                handleFile(virtualFile, onGCodeReady, window.switchTab, urumiMeta);

                if (window.switchTab) {
                    window.switchTab('gcode-preview');
                }
            } catch (e) {
                log(`Skeletonization Failed: ${e.message}`, "error");
            }
        });
    });
}

try {
    setupUrumiCamPushListener();
} catch (e) {
    console.error("Failed to setup UrumiCam push listener:", e);
}


// Handle "Open File" button
document.getElementById('fileInput').addEventListener('change', (e) => {
    state.currentFile = e.target.files[0];
    handleFile(state.currentFile, onGCodeReady, window.switchTab);
});

// Helper: compute steps/unit from single input
function getAxisSteps(inputId, fallback) {
    const v = parseFloat(document.getElementById(inputId)?.value);
    return (isNaN(v) || v <= 0) ? fallback : v;
}

const retriggerConversion = () => {
    if (state.gcode && !document.getElementById('canvasContainer').classList.contains('hidden')) {
        renderGCode(state.gcode, 'gcodeCanvas', 'canvasContainer', state.stepsPerMM, -1, state.binaryPackets, state.packetMeta);
    }
    if (state.currentFile && state.currentFile.name.toLowerCase().endsWith('.svg')) {
        log('Re-calculating trajectory with new settings...', 'info');
        handleFile(state.currentFile, onGCodeReady, window.switchTab);
    }
};

// Slider sync
segmentLengthSlider.addEventListener('input', (e) => { segmentLengthInput.value = e.target.value; });
segmentLengthInput.addEventListener('input', (e) => { segmentLengthSlider.value = e.target.value; });
cuttingSpeedSlider.addEventListener('input', (e) => { cuttingSpeedInput.value = e.target.value; });
cuttingSpeedInput.addEventListener('input', (e) => { cuttingSpeedSlider.value = e.target.value; });
if (zSpeedSlider && zSpeedInput) {
    zSpeedSlider.addEventListener('input', (e) => { zSpeedInput.value = e.target.value; });
    zSpeedInput.addEventListener('input', (e) => { zSpeedSlider.value = e.target.value; });
}

const maxStepsSlider = document.getElementById('maxStepsSlider');
const maxStepsInput = document.getElementById('maxStepsInput');
const maxLinearSpeedSlider = document.getElementById('maxLinearSpeedSlider');
const maxLinearSpeedInput = document.getElementById('maxLinearSpeedInput');
const maxRotationalSpeedSlider = document.getElementById('maxRotationalSpeedSlider');
const maxRotationalSpeedInput = document.getElementById('maxRotationalSpeedInput');

if (maxStepsSlider && maxStepsInput) {
    maxStepsSlider.addEventListener('input', (e) => { maxStepsInput.value = e.target.value; });
    maxStepsInput.addEventListener('input', (e) => { maxStepsSlider.value = e.target.value; });
}
if (maxLinearSpeedSlider && maxLinearSpeedInput) {
    maxLinearSpeedSlider.addEventListener('input', (e) => { maxLinearSpeedInput.value = e.target.value; });
    maxLinearSpeedInput.addEventListener('input', (e) => { maxLinearSpeedSlider.value = e.target.value; });
}
if (maxRotationalSpeedSlider && maxRotationalSpeedInput) {
    maxRotationalSpeedSlider.addEventListener('input', (e) => { maxRotationalSpeedInput.value = e.target.value; });
    maxRotationalSpeedInput.addEventListener('input', (e) => { maxRotationalSpeedSlider.value = e.target.value; });
}

// Watch all config inputs for changes
[
    segmentLengthSlider, segmentLengthInput, cuttingSpeedSlider, cuttingSpeedInput,
    zSpeedSlider, zSpeedInput,
    maxStepsSlider, maxStepsInput, maxLinearSpeedSlider, maxLinearSpeedInput,
    maxRotationalSpeedSlider, maxRotationalSpeedInput,
    'bedWidthInput', 'bedHeightInput', 'gantryWidthInput', 'gantryHeightInput',
    'xRs485Id', 'xStepsPerMM',
    'yRs485Id', 'yStepsPerMM',
    'zRs485Id', 'zStepsPerMM',
    'aRs485Id', 'aStepsPerDeg',
].forEach(idOrEl => {
    const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (el) {
        el.addEventListener('change', retriggerConversion);
    }
});

// Watch simulation mode checkbox
const simModeCheckbox = document.getElementById('simModeCheckbox');
if (simModeCheckbox) {
    simModeCheckbox.addEventListener('change', () => {
        updateStatus(connection.connected);
        if (simModeCheckbox.checked && state.gcode) {
            btnStart.disabled = false;
        }
    });
}

// No initial axis labels to update anymore

// Modal Logic
btnSettings.addEventListener('click', () => {
    configModal.classList.remove('hidden');
    // small delay to allow display:block to apply before animating opacity
    setTimeout(() => configModal.classList.add('visible'), 10);
});

// Measure Toggle for Trajectory Preview
btnMeasurePreview.addEventListener('click', () => {
    const canvas = document.getElementById('gcodeCanvas');
    if (canvas && canvas._trajectoryViewport) {
        const vp = canvas._trajectoryViewport;
        vp.measureMode = !vp.measureMode;
        if (!vp.measureMode) {
            vp.measureStartX = null;
            vp.measureStartY = null;
            vp.measureEndX = null;
            vp.measureEndY = null;
        }
        btnMeasurePreview.classList.toggle('active', vp.measureMode);
        canvas._renderTrajectory?.();
    }
});

const closeModal = () => {
    configModal.classList.remove('visible');
    setTimeout(() => configModal.classList.add('hidden'), 300); // match transition duration
};

btnCloseModal.addEventListener('click', closeModal);
configModal.addEventListener('click', (e) => {
    if (e.target === configModal) closeModal();
});

// Handle Drag & Drop
// We need to prevent the default browser behavior (which is opening the file in the tab)
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
    }, false);
});

// Visual cue when dragging over
dropZone.addEventListener('dragover', () => {
    document.querySelectorAll('.empty-state').forEach(el => el.classList.add('drag-over'));
});

dropZone.addEventListener('dragleave', () => {
    document.querySelectorAll('.empty-state').forEach(el => el.classList.remove('drag-over'));
});

// Handle the Drop
dropZone.addEventListener('drop', (e) => {
    document.querySelectorAll('.empty-state').forEach(el => el.classList.remove('drag-over'));
    state.currentFile = e.dataTransfer.files[0];
    handleFile(state.currentFile, onGCodeReady, window.switchTab);
});

// Connection requires a user gesture for WebSerial, so we don't auto-connect
// on page load anymore.

// ============================================================================
//  JOG CONTROL
// ============================================================================

/**
 * JOG STATE
 * We track a local "displayed" position so the user can see accumulated deltas.
 * This is NOT the machine's actual encoder position — it's a dead-reckoning counter.
 */
const jogState = {
    step: 0.1,        // Current step size in mm
    stepX: 0,
    stepY: 0,
    stepZ: 0,
    stepA: 0,
    get posX() { return this.stepX / getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X); },
    set posX(val) { this.stepX = Math.round(val * getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X)); },
    get posY() { return this.stepY / getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y); },
    set posY(val) { this.stepY = Math.round(val * getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y)); },
    get posZ() { return this.stepZ / getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z); },
    set posZ(val) { this.stepZ = Math.round(val * getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z)); },
    get posA() { return this.stepA / getAxisSteps('aStepsPerDeg', DEFAULT_STEPS.A); },
    set posA(val) { this.stepA = Math.round(val * getAxisSteps('aStepsPerDeg', DEFAULT_STEPS.A)); }
};

const jogModal = document.getElementById('jogModal');
const btnJog = document.getElementById('btnJog');

/** Open / close helpers (same fade pattern as config modal) */
function openJogModal() {
    jogModal.classList.remove('hidden');
    setTimeout(() => jogModal.classList.add('visible'), 10);
    // Bind keyboard jogging while modal is open
    window.addEventListener('keydown', handleJogKey);
}

function closeJogModal() {
    jogModal.classList.remove('visible');
    setTimeout(() => jogModal.classList.add('hidden'), 300);
    window.removeEventListener('keydown', handleJogKey);
}

btnJog.addEventListener('click', openJogModal);
document.getElementById('btnCloseJog').addEventListener('click', closeJogModal);
jogModal.addEventListener('click', (e) => { if (e.target === jogModal) closeJogModal(); });

/** Step-size pill buttons */
document.querySelectorAll('.jog-step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.jog-step-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        jogState.step = parseFloat(btn.dataset.step);
    });
});

/**
 * SEND JOG
 * Builds and sends a `jog <dx_mm> <dy_mm> <dz_mm> <da_deg>` command.
 * The Pico firmware is expected to interpret this as a relative move.
 *
 * @param {number} dx - X delta in mm
 * @param {number} dy - Y delta in mm
 * @param {number} dz - Z delta in mm
 * @param {number} da - A delta in degrees
 */
function sendJog(dx, dy, dz, da = 0) {
    const isSimMode = document.getElementById('simModeCheckbox')?.checked;
    if (!connection.connected && !isSimMode) {
        log('Jog: Not connected to machine.', 'error');
        return;
    }

    // 1. Get current scaling factors from UI
    const xStepsPerMM = getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X);
    const yStepsPerMM = getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y);
    const zStepsPerMM = getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z);
    const aStepsPerDeg = getAxisSteps('aStepsPerDeg', DEFAULT_STEPS.A);
    const feedRate = parseFloat(document.getElementById('cuttingSpeedInput')?.value) || 30;
    const zSpeed = parseFloat(document.getElementById('zSpeedInput')?.value) || 4;

    // 2. Calculate relative steps
    // Note: Z-axis convention is positive for DOWN, so we negate dz (Up is positive)
    const relX = Math.round(dx * xStepsPerMM);
    const relY = Math.round(dy * yStepsPerMM);
    const relZ = Math.round(-dz * zStepsPerMM);
    const relA = Math.round(da * aStepsPerDeg);

    if (relX === 0 && relY === 0 && relZ === 0 && relA === 0) return;

    // 3. Calculate interval for microsegment
    const maxAbsStep = Math.max(Math.abs(relX), Math.abs(relY), Math.abs(relZ), Math.abs(relA));
    let stepsPerUnitOfMaxAxis = 1.0;
    let effectiveFeedRate = feedRate;

    if (maxAbsStep === Math.abs(relX)) {
        stepsPerUnitOfMaxAxis = xStepsPerMM;
    } else if (maxAbsStep === Math.abs(relY)) {
        stepsPerUnitOfMaxAxis = yStepsPerMM;
    } else if (maxAbsStep === Math.abs(relZ)) {
        stepsPerUnitOfMaxAxis = zStepsPerMM;
        effectiveFeedRate = zSpeed;
    } else {
        stepsPerUnitOfMaxAxis = aStepsPerDeg;
    }

    const speed = effectiveFeedRate * stepsPerUnitOfMaxAxis;
    const interval = Math.max(1, Math.min(Math.round(150_000_000 / speed), 150_000_000));

    const packet = packMicrosegment(relX, relY, relZ, relA, interval, 1, 0);

    if (isSimMode) {
        log(`[SIM JOG] dx:${dx} dy:${dy} dz:${dz} da:${da} (interval:${interval})`, 'info');
        updatePositionFromPacket(packet);
    } else {
        state.activeRunType = 'jog';
        state.isSending = true;

        // Jogging should never run the suction bed.
        sendSuctionCommands(false, false);
        updateSuctionUI();

        // Use the robust executeNextTextCommand pipeline without destroying loaded SVGs
        state.jogPackets = [packet];
        state.gcodeQueue = ['enable all 1', 'WAIT_MS:200', '__JOG_BINARY_STREAM__'];

        executeNextTextCommand();
    }
}

// D-pad and Z buttons
document.getElementById('jogXPlus').addEventListener('click', () => sendJog(-jogState.step, 0, 0, 0));
document.getElementById('jogXMinus').addEventListener('click', () => sendJog(jogState.step, 0, 0, 0));
document.getElementById('jogYPlus').addEventListener('click', () => sendJog(0, jogState.step, 0, 0));
document.getElementById('jogYMinus').addEventListener('click', () => sendJog(0, -jogState.step, 0, 0));
document.getElementById('jogZPlus').addEventListener('click', () => sendJog(0, 0, jogState.step, 0));
document.getElementById('jogZMinus').addEventListener('click', () => sendJog(0, 0, -jogState.step, 0));
document.getElementById('jogAPlus').addEventListener('click', () => sendJog(0, 0, 0, jogState.step));
document.getElementById('jogAMinus').addEventListener('click', () => sendJog(0, 0, 0, -jogState.step));

/**
 * GO TO ZERO ("Home")
 * This firmware has NO homing cycle — there is no `home` command and no limit
 * switches. Origin is established purely by `setorigin`. So "Home" returns the
 * gantry to (0,0) with a safe Z-retract using binary MicroSegments (the same
 * pattern as park), then issues `setorigin` to zero the Pico's authoritative
 * position counter. Dead-reckoning converges to ~0 as the move is ACKed.
 * (Assessment R2 / fix F2.)
 */
function goToZero() {
    const isSimMode = document.getElementById('simModeCheckbox')?.checked;
    if (!connection.connected && !isSimMode) { log('Home: Not connected.', 'error'); return; }
    if (state.isSending) { log('Home: a move/job is already running.', 'warning'); return; }

    const xStepsPerMM = getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X);
    const yStepsPerMM = getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y);
    const zStepsPerMM = getAxisSteps('zStepsPerMM', DEFAULT_STEPS.Z);
    const feedRate = parseFloat(document.getElementById('cuttingSpeedInput')?.value) || 30;
    const zSpeed = parseFloat(document.getElementById('zSpeedInput')?.value) || 4;

    const cmds = [];

    // Step 1: retract Z to a safe height (5 mm above bed) before traversing.
    const zTarget = 5;
    if (jogState.posZ < zTarget) {
        const relZ = Math.round(-(zTarget - jogState.posZ) * zStepsPerMM); // Up = negative Z steps
        if (relZ !== 0) {
            const stepVz = Math.max(1, Math.round(zSpeed * zStepsPerMM));
            const interval = Math.max(1, Math.min(Math.round(150_000_000 / stepVz), 150_000_000));
            cmds.push(packMicrosegment(0, 0, relZ, 0, interval, 0x01, 0));
        }
    }

    // Step 2: traverse X/Y back to the origin.
    const relX = Math.round(-jogState.posX * xStepsPerMM);
    const relY = Math.round(-jogState.posY * yStepsPerMM);
    if (relX !== 0 || relY !== 0) {
        const maxAbsStep = Math.max(Math.abs(relX), Math.abs(relY));
        const spu = maxAbsStep === Math.abs(relX) ? xStepsPerMM : yStepsPerMM;
        const interval = Math.max(1, Math.min(Math.round(150_000_000 / (feedRate * spu)), 150_000_000));
        cmds.push(packMicrosegment(relX, relY, 0, 0, interval, 0, 0));
    }

    log('Home: returning to origin (0,0) then re-zeroing position...', 'info');
    state.activeRunType = 'jog';
    state.isSending = true;
    setStartButtonState(true, false);

    // Stream the move (if any) then `setorigin` to re-establish the firmware zero.
    if (cmds.length > 0) {
        state.binaryPackets = cmds;
        state.packetMeta = [];
        state.gcodeQueue = ['__BINARY_STREAM__', 'setorigin'];
    } else {
        state.gcodeQueue = ['setorigin'];
    }
    executeNextTextCommand();
}

// Home button — return to origin (0,0) and re-zero via setorigin.
document.getElementById('jogHome').addEventListener('click', goToZero);

// Reset position display
document.getElementById('jogResetPos').addEventListener('click', () => {
    jogState.posX = 0; jogState.posY = 0; jogState.posZ = 0; jogState.posA = 0;
    document.getElementById('jogPosX').textContent = '0.00';
    document.getElementById('jogPosY').textContent = '0.00';
    document.getElementById('jogPosZ').textContent = '0.00';
    document.getElementById('jogPosA').textContent = '0.00';
});

/**
 * KEYBOARD JOG HANDLER
 * Arrow keys → X/Y, PageUp/PageDown → Z, Home → zero.
 * Only active when the jog modal is open.
 */
function handleJogKey(e) {
    // Don't steal keys from text inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const keyMap = {
        'ArrowRight': () => sendJog(jogState.step, 0, 0),
        'ArrowLeft': () => sendJog(-jogState.step, 0, 0),
        'ArrowUp': () => sendJog(0, jogState.step, 0),
        'ArrowDown': () => sendJog(0, -jogState.step, 0),
        'PageUp': () => sendJog(0, 0, jogState.step, 0),
        'PageDown': () => sendJog(0, 0, -jogState.step, 0),
        '[': () => sendJog(0, 0, 0, -jogState.step),
        ']': () => sendJog(0, 0, 0, jogState.step),
        'Home': () => document.getElementById('jogHome').click(),
    };

    if (keyMap[e.key]) {
        e.preventDefault();
        keyMap[e.key]();
    }
}

// ============================================================
//  SUCTION BED CONTROL LOGIC
// ============================================================

/**
 * Recalculates the active zones based on drawn paths or G-code commands.
 * Splits the machine bed (bedW x bedH) into a 2x3 grid.
 *
 * @param {string} gcode - Raw G-code or Trajectory queue text.
 * @param {Uint8Array[]} packets - Binary MicroSegment packets for SVG-driven jobs.
 * @returns {Array<number>} List of active zone IDs (1-6).
 */
function calculateActiveZones(gcode, packets = []) {
    const bedW = parseFloat(document.getElementById('bedWidthInput')?.value) || 630;
    const bedH = parseFloat(document.getElementById('bedHeightInput')?.value) || 780;

    const lines = gcode.split('\n');
    let cur = { x: 0, y: 0 };
    let isPenDown = false;

    const active = new Set();

    const addZone = (x, y) => {
        // Clamp bounds to prevent array index overflow. The machine origin is
        // bottom-left, so +X moves rightward across the bed.
        const cx = Math.max(0, Math.min(bedW - 0.001, x));
        const cy = Math.max(0, Math.min(bedH - 0.001, y));
        const leftBasedX = cx;

        const col = Math.floor(leftBasedX / (bedW / 3)); // 0 to 2, left to right
        const row = cy >= (bedH / 2) ? 0 : 1;           // Row 0 is Top, Row 1 is Bottom

        let zoneNum = 1;
        if (row === 0) {
            zoneNum = col + 1; // 1, 2, 3
        } else {
            zoneNum = col + 4; // 4, 5, 6
        }
        active.add(zoneNum);
    };

    const getAxisSteps = (mId, miId, dId, fallback) => {
        const m = parseFloat(document.getElementById(mId)?.value) || 200;
        const mi = parseFloat(document.getElementById(miId)?.value) || 1;
        const d = parseFloat(document.getElementById(dId)?.value) || 1;
        const v = (m * mi) / d;
        return (isNaN(v) || v <= 0) ? fallback : v;
    };

    const idX = parseInt(document.getElementById('xRs485Id')?.value) || 3;
    const idY = parseInt(document.getElementById('yRs485Id')?.value) || 2;
    const idZ = parseInt(document.getElementById('zRs485Id')?.value) || 1;

    const xStepsPerMM = getAxisSteps('xStepsPerMM', DEFAULT_STEPS.X);
    const yStepsPerMM = getAxisSteps('yStepsPerMM', DEFAULT_STEPS.Y);

    lines.forEach(line => {
        line = line.split(';')[0].trim().toUpperCase();
        if (!line) return;

        if (line.startsWith('MOVE')) {
            const parts = line.split(/[\s,]+/);
            const count = parseInt(parts[1]);
            if (isNaN(count) || parts.length < 2 + count * 2) return;

            let dx = 0, dy = 0, zVal = 0;
            for (let i = 0; i < count; i++) {
                const id = parseInt(parts[2 + i]);
                const steps = parseInt(parts[2 + count + i]);

                if (id === idX) dx = steps / xStepsPerMM;
                else if (id === idY) dy = steps / yStepsPerMM;
                else if (id === idZ) zVal = steps;
            }

            if (zVal > 0) isPenDown = true;
            else if (zVal < 0) isPenDown = false;

            const next = { x: cur.x + dx, y: cur.y + dy };

            if (isPenDown) {
                addZone(cur.x, cur.y);
                addZone(next.x, next.y);
                addZone((cur.x + next.x) / 2, (cur.y + next.y) / 2);
            }
            cur = next;
            return;
        }

        const isMove = line.startsWith('G0') || line.startsWith('G1');
        if (isMove) {
            const xMatch = line.match(/X([-+]?\d*\.?\d+)/);
            const yMatch = line.match(/Y([-+]?\d*\.?\d+)/);

            const next = { ...cur };
            if (xMatch) next.x = parseFloat(xMatch[1]);
            if (yMatch) next.y = parseFloat(yMatch[1]);

            const isCut = line.startsWith('G1');
            if (isCut) {
                addZone(cur.x, cur.y);
                addZone(next.x, next.y);
                addZone((cur.x + next.x) / 2, (cur.y + next.y) / 2);
            }
            cur = next;
        }
    });

    if (packets && packets.length > 0) {
        cur = { x: 0, y: 0 };
        isPenDown = false;

        for (const pkt of packets) {
            if (!(pkt instanceof Uint8Array) || pkt.length < 13) continue;

            const view = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
            if (view.getUint8(0) !== 0xAB) continue;

            const dx = view.getInt32(1, true) / xStepsPerMM;
            const dy = view.getInt32(5, true) / yStepsPerMM;
            const dz = view.getInt32(9, true);

            if (dz > 0) isPenDown = true;
            else if (dz < 0) isPenDown = false;

            const next = { x: cur.x + dx, y: cur.y + dy };

            if (isPenDown && (dx !== 0 || dy !== 0)) {
                addZone(cur.x, cur.y);
                addZone(next.x, next.y);
                addZone((cur.x + next.x) / 2, (cur.y + next.y) / 2);
            }

            cur = next;
        }
    }

    return Array.from(active);
}

function getActiveSuctionZones() {
    return state.suctionMode === 'auto'
        ? state.suctionAutoActiveZones
        : state.suctionZones.map((z, idx) => z ? (idx + 1) : null).filter(z => z !== null);
}

function shouldRunSuction() {
    if (!state.suctionControlEnabled) {
        return false;
    }

    const hasActiveZones = getActiveSuctionZones().length > 0;
    if (!hasActiveZones) return false;

    if (state.activeRunType === 'job') {
        return true;
    }

    if (state.activeRunType === 'jog' || state.activeRunType === 'park') {
        return false;
    }

    return state.suctionMode === 'manual';
}

function buildSuctionCommandSequence(shouldRun) {
    const activeSet = new Set(shouldRun ? getActiveSuctionZones().filter(z => z >= 1 && z <= 6) : []);
    const servoCommands = [];

    for (let zone = 1; zone <= 6; zone++) {
        servoCommands.push(`servo ${zone} ${activeSet.has(zone) ? 1 : 0}`);
    }

    if (activeSet.size > 0) {
        return [...servoCommands, 'suction 1'];
    }
    return ['suction 0', ...servoCommands];
}

function getSuctionSignature(shouldRun) {
    if (!shouldRun) return 'OFF';
    return buildSuctionCommandSequence(true).join('|');
}

function seedManualZonesFromAuto() {
    state.suctionZones = [false, false, false, false, false, false];
    state.suctionAutoActiveZones.forEach(z => {
        if (z >= 1 && z <= 6) state.suctionZones[z - 1] = true;
    });
}

/**
 * Synchronizes the suction panel UI state with the current global controller state.
 */
function updateSuctionUI() {
    const autoBtn = document.getElementById('btnSuctionModeAuto');
    const manualBtn = document.getElementById('btnSuctionModeManual');
    const manualOnBtn = document.getElementById('btnSuctionManualOn');
    const manualOffBtn = document.getElementById('btnSuctionManualOff');
    const statusText = document.getElementById('suctionStatusText');
    const fanIcon = document.getElementById('suctionFanIcon');
    const cells = document.querySelectorAll('.suction-cell');

    // Toggle active state classes for pills
    if (autoBtn && manualBtn) {
        if (state.suctionMode === 'auto') {
            autoBtn.classList.add('active');
            manualBtn.classList.remove('active');
        } else {
            autoBtn.classList.remove('active');
            manualBtn.classList.add('active');
        }
    }

    if (manualOnBtn && manualOffBtn) {
        manualOnBtn.classList.toggle('active', state.suctionControlEnabled);
        manualOffBtn.classList.toggle('active', !state.suctionControlEnabled);
    }

    // Identify active zones based on current mode
    const activeList = getActiveSuctionZones();

    // Sync individual cells in the 2x3 bed visualizer grid
    cells.forEach(cell => {
        const zoneNum = parseInt(cell.dataset.zone);
        if (activeList.includes(zoneNum)) {
            cell.classList.add('active');
        } else {
            cell.classList.remove('active');
        }
    });

    const isRunning = shouldRunSuction();

    // Status text update
    if (statusText) {
        if (isRunning) {
            statusText.textContent = 'ON';
            statusText.className = 'suction-status-active';
        } else {
            statusText.textContent = 'OFF';
            statusText.className = 'suction-status-idle';
        }
    }

    // Fan micro-animation state
    if (fanIcon) {
        if (isRunning) {
            fanIcon.classList.add('spinning');
        } else {
            fanIcon.classList.remove('spinning');
        }
    }
}

/**
 * Formats and transmits current suction status to the connected hardware over WebSerial/Pico.
 */
function sendSuctionCommands(force = false, overrideShouldRun = shouldRunSuction()) {
    if (!connection.connected) return;

    const signature = getSuctionSignature(overrideShouldRun);
    if (!overrideShouldRun && !force && (state.suctionLastSignature === null || state.suctionLastSignature === 'OFF')) {
        return;
    }
    if (!force && signature === state.suctionLastSignature) {
        return;
    }

    for (const cmd of buildSuctionCommandSequence(overrideShouldRun)) {
        connection.send(cmd, true);
    }
    state.suctionLastSignature = signature;
}

/**
 * Initializes and registers event listeners for the suction control UI panel elements.
 */
function initSuctionBed() {
    const autoBtn = document.getElementById('btnSuctionModeAuto');
    const manualBtn = document.getElementById('btnSuctionModeManual');
    const manualOnBtn = document.getElementById('btnSuctionManualOn');
    const manualOffBtn = document.getElementById('btnSuctionManualOff');
    const cells = document.querySelectorAll('.suction-cell');

    if (autoBtn && manualBtn) {
        autoBtn.addEventListener('click', () => {
            state.suctionMode = 'auto';
            updateSuctionUI();
            sendSuctionCommands();
            log('Suction Bed: Switched to Automatic (Drawing-Based) Mode.', 'info');
        });
        manualBtn.addEventListener('click', () => {
            state.suctionMode = 'manual';
            seedManualZonesFromAuto();
            updateSuctionUI();
            sendSuctionCommands();
            log('Suction Bed: Switched to Manual Override Mode.', 'info');
        });
    }

    if (manualOnBtn && manualOffBtn) {
        manualOnBtn.addEventListener('click', () => {
            state.suctionControlEnabled = true;
            updateSuctionUI();
            sendSuctionCommands();
            log('Suction Bed Control: Enabled.', 'info');
        });

        manualOffBtn.addEventListener('click', () => {
            state.suctionControlEnabled = false;
            updateSuctionUI();
            sendSuctionCommands(true, false);
            log('Suction Bed Control: Disabled.', 'info');
        });
    }

    cells.forEach(cell => {
        cell.addEventListener('click', () => {
            const zoneNum = parseInt(cell.dataset.zone);
            if (isNaN(zoneNum) || zoneNum < 1 || zoneNum > 6) return;

            if (state.suctionMode === 'auto') {
                state.suctionMode = 'manual';
                // Clone calculated zones to manual array for clean starting point override
                seedManualZonesFromAuto();
                log('Suction Bed: Clicking cell switched system to Manual override.', 'info');
            }

            state.suctionZones[zoneNum - 1] = !state.suctionZones[zoneNum - 1];
            updateSuctionUI();
            sendSuctionCommands();
        });
    });

    // Run the initial UI sync
    updateSuctionUI();
}

// Kickstart the suction bed subsystem
initSuctionBed();
initFrameGenerator();
