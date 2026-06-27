export function initFrameGenerator() {
    const btnOpen = document.getElementById('btnOpenFrameGen');
    const btnClose = document.getElementById('btnCloseFrameGen');
    const modal = document.getElementById('frameGenModal');

    const inputWidth = document.getElementById('frameGenWidth');
    const inputHeight = document.getElementById('frameGenHeight');
    const inputBleed = document.getElementById('frameGenBleed');
    const inputArucoSize = document.getElementById('frameGenArucoSize');

    const btnDownloadSvg = document.getElementById('btnDownloadSvg');
    const btnDownloadJson = document.getElementById('btnDownloadJson');

    if (!btnOpen || !modal) return;

    function updatePreview() {
        const svgString = generateSVG(
            parseFloat(inputWidth.value) || 600,
            parseFloat(inputHeight.value) || 750,
            parseFloat(inputBleed.value) || 50,
            parseFloat(inputArucoSize.value) || 50
        );
        const container = document.getElementById('frameGenPreviewContainer');
        if (container) {
            container.innerHTML = svgString;
            const svg = container.querySelector('svg');
            if (svg) {
                svg.style.width = '100%';
                svg.style.height = '100%';
                svg.style.objectFit = 'contain';
            }
        }
    }

    [inputWidth, inputHeight, inputBleed, inputArucoSize].forEach(input => {
        if (input) input.addEventListener('input', updatePreview);
    });

    const btnExpand = document.getElementById('btnExpandPreview');
    const previewContainer = document.getElementById('frameGenPreviewContainer');
    const fullscreenOverlay = document.getElementById('fullscreenPreviewOverlay');
    const fullscreenContent = document.getElementById('fullscreenPreviewContent');
    const btnCloseFullscreen = document.getElementById('btnCloseFullscreenPreview');
    
    function showFullscreenPreview() {
        if (!fullscreenOverlay || !fullscreenContent) return;
        const svgString = generateSVG(
            parseFloat(inputWidth.value) || 600,
            parseFloat(inputHeight.value) || 750,
            parseFloat(inputBleed.value) || 50,
            parseFloat(inputArucoSize.value) || 50
        );
        fullscreenContent.innerHTML = svgString;
        const svg = fullscreenContent.querySelector('svg');
        if (svg) {
            svg.style.width = '100%';
            svg.style.height = '100%';
            svg.style.objectFit = 'contain';
        }
        fullscreenOverlay.classList.remove('hidden');
        fullscreenOverlay.style.display = 'flex';
    }

    function hideFullscreenPreview() {
        if (fullscreenOverlay) {
            fullscreenOverlay.classList.add('hidden');
            fullscreenOverlay.style.display = 'none';
        }
    }
    
    if (btnExpand) btnExpand.addEventListener('click', (e) => {
        e.stopPropagation();
        showFullscreenPreview();
    });
    
    if (previewContainer) previewContainer.addEventListener('click', () => {
        showFullscreenPreview();
    });

    if (btnCloseFullscreen) btnCloseFullscreen.addEventListener('click', (e) => {
        e.stopPropagation();
        hideFullscreenPreview();
    });

    if (fullscreenOverlay) fullscreenOverlay.addEventListener('click', (e) => {
        if (e.target === fullscreenOverlay) {
            hideFullscreenPreview();
        }
    });

    btnOpen.addEventListener('click', () => {
        // Pre-fill width/height from the current config modal
        const currentW = document.getElementById('bedWidthInput')?.value;
        const currentH = document.getElementById('bedHeightInput')?.value;
        if (currentW) inputWidth.value = currentW;
        if (currentH) inputHeight.value = currentH;
        
        updatePreview();
        
        modal.classList.remove('hidden');
        setTimeout(() => modal.classList.add('visible'), 10);
    });

    btnClose.addEventListener('click', () => {
        modal.classList.remove('visible');
        setTimeout(() => modal.classList.add('hidden'), 300);
    });

    btnDownloadSvg.addEventListener('click', () => {
        const svgString = generateSVG(
            parseFloat(inputWidth.value),
            parseFloat(inputHeight.value),
            parseFloat(inputBleed.value),
            parseFloat(inputArucoSize.value)
        );
        downloadFile(svgString, 'custom.svg', 'image/svg+xml');
    });

    btnDownloadJson.addEventListener('click', () => {
        const jsonString = generateJSON(
            parseFloat(inputWidth.value),
            parseFloat(inputHeight.value),
            parseFloat(inputBleed.value)
        );
        downloadFile(jsonString, 'custom.json', 'application/json');
    });
}

const ARUCO_DICT = {
    12: [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 1, 1, 1, 0, 0],
        [0, 1, 0, 1, 1, 0],
        [0, 0, 1, 1, 1, 0],
        [0, 0, 0, 0, 0, 0]
    ],
    13: [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 0, 0],
        [0, 1, 0, 1, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 1, 1, 1, 1, 0],
        [0, 0, 0, 0, 0, 0]
    ],
    14: [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 0, 0],
        [0, 0, 1, 0, 0, 0],
        [0, 1, 0, 1, 1, 0],
        [0, 0, 0, 0, 1, 0],
        [0, 0, 0, 0, 0, 0]
    ],
    15: [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 0, 0],
        [0, 0, 1, 1, 0, 0],
        [0, 0, 0, 1, 1, 0],
        [0, 1, 1, 1, 0, 0],
        [0, 0, 0, 0, 0, 0]
    ]
};

function getMarkerSVG(markerId, x, y, size) {
    const img = ARUCO_DICT[markerId];
    if (!img) return '';

    let rects = [];
    rects.push(`<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="white"/>`);
    
    const cellSize = size / 6.0;
    for (let row = 0; row < 6; row++) {
        for (let col = 0; col < 6; col++) {
            if (img[row][col] === 0) { // Black pixel
                const px = x + col * cellSize;
                const py = y + row * cellSize;
                rects.push(`<rect x="${px}" y="${py}" width="${cellSize + 0.1}" height="${cellSize + 0.1}" fill="black"/>`);
            }
        }
    }
    return rects.join("\n");
}

export function generateSVG(width, height, offset, arucoSize) {
    const page_width = width + (offset * 2);
    const page_height = height + (offset * 2);

    let svg_elements = [];
    
    // White background
    svg_elements.push(`<rect x="0" y="0" width="${page_width}" height="${page_height}" fill="white"/>`);
    
    // Group all visual frame elements
    svg_elements.push(`<g id="urumi-frame" data-ignore="true">`);

    // Markers (Centered around 0,0 / width,0 / etc)
    svg_elements.push(getMarkerSVG(12, 0 + offset - arucoSize/2, 0 + offset - arucoSize/2, arucoSize));
    svg_elements.push(getMarkerSVG(13, width + offset - arucoSize/2, 0 + offset - arucoSize/2, arucoSize));
    svg_elements.push(getMarkerSVG(14, width + offset - arucoSize/2, height + offset - arucoSize/2, arucoSize));
    svg_elements.push(getMarkerSVG(15, 0 + offset - arucoSize/2, height + offset - arucoSize/2, arucoSize));

    // Checkerboard edge markers
    const step = 50;
    
    // Top and Bottom edges
    for (let x = offset * 2; x <= width - step; x += step) {
        const index = Math.round((x - (offset * 2)) / step);
        const fill1 = (index % 2 === 0) ? 'white' : 'black';
        const fill2 = (index % 2 === 0) ? 'black' : 'white';
        
        // Top edge
        svg_elements.push(`<rect x="${x}" y="${offset - arucoSize/2}" width="${step}" height="${arucoSize/2}" fill="${fill1}"/>`);
        svg_elements.push(`<rect x="${x}" y="${offset}" width="${step}" height="${arucoSize/2}" fill="${fill2}"/>`);
        
        // Bottom edge
        svg_elements.push(`<rect x="${x}" y="${height + offset - arucoSize/2}" width="${step}" height="${arucoSize/2}" fill="${fill1}"/>`);
        svg_elements.push(`<rect x="${x}" y="${height + offset}" width="${step}" height="${arucoSize/2}" fill="${fill2}"/>`);
    }

    // Left and Right edges
    for (let y = offset * 2; y <= height - step; y += step) {
        const index = Math.round((y - (offset * 2)) / step);
        const fill1 = (index % 2 === 0) ? 'white' : 'black';
        const fill2 = (index % 2 === 0) ? 'black' : 'white';
        
        // Left edge
        svg_elements.push(`<rect x="${offset - arucoSize/2}" y="${y}" width="${arucoSize/2}" height="${step}" fill="${fill1}"/>`);
        svg_elements.push(`<rect x="${offset}" y="${y}" width="${arucoSize/2}" height="${step}" fill="${fill2}"/>`);
        
        // Right edge
        svg_elements.push(`<rect x="${width + offset - arucoSize/2}" y="${y}" width="${arucoSize/2}" height="${step}" fill="${fill1}"/>`);
        svg_elements.push(`<rect x="${width + offset}" y="${y}" width="${arucoSize/2}" height="${step}" fill="${fill2}"/>`);
    }

    // Inner frame border (safe drawing area boundary)
    const inner_x = offset + arucoSize / 2;
    const inner_y = offset + arucoSize / 2;
    const inner_w = width - arucoSize;
    const inner_h = height - arucoSize;
    svg_elements.push(`<rect x="${inner_x}" y="${inner_y}" width="${inner_w}" height="${inner_h}" fill="none" stroke="black" stroke-width="1.5" rx="8" ry="8"/>`);

    svg_elements.push(`</g>`);
    
    let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    svg += `<svg width="${page_width}mm" height="${page_height}mm" viewBox="0 0 ${page_width} ${page_height}" xmlns="http://www.w3.org/2000/svg">\n`;
    svg += `  ${svg_elements.join("")}\n`;
    svg += `</svg>`;
    
    return svg;
}

function generateJSON(width, height, arucoSize) {
    // Generate corner_pos: Points every 50mm along the perimeter
    const corner_pos = [];
    const step = 50;
    
    // Top edge
    for (let x = 100; x <= width - 150; x += step) {
        corner_pos.push([x, 0]);
    }
    // Right edge
    for (let y = 100; y <= height - 150; y += step) {
        corner_pos.push([width, y]);
    }
    // Bottom edge
    for (let x = width - 150; x >= 100; x -= step) {
        corner_pos.push([x, height]);
    }
    // Left edge
    for (let y = height - 150; y >= 100; y -= step) {
        corner_pos.push([0, y]);
    }

    const config = {
        width: width,
        height: height,
        aruco_id: [12, 13, 14, 15],
        aruco_pos: [
            [0, 0],
            [width, 0],
            [width, height],
            [0, height]
        ],
        aruco_size: arucoSize,
        corner_size: 40,
        corner_pos: [corner_pos],
        margins: {
            inner: 25,
            outer: 25,
            inner_content: 28
        }
    };

    return JSON.stringify(config, null, 2);
}

function downloadFile(content, fileName, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}
