const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    page.on('console', msg => {
        if(msg.text().includes('POINTER') || msg.text().includes('RENDER MEASURE')) {
            console.log('BROWSER LOG:', msg.text());
        }
    });

    await page.goto('http://localhost:59351');
    
    // Switch to Draw tab
    const drawTab = await page.$('button[onclick="switchTab(\'draw\')"]');
    await drawTab.click();
    await page.waitForTimeout(500);
    
    // Select rect tool
    const rectTool = await page.$('#rectTool');
    if (rectTool) {
        await rectTool.click();
        await page.waitForTimeout(100);
    }
    
    // Draw
    const canvas = await page.$('#drawCanvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 200, { steps: 5 });
    await page.mouse.up();
    
    await page.waitForTimeout(500);
    
    // Send to cutter
    const sendBtn = await page.$('#btnSendToCutter');
    if (sendBtn) {
        await sendBtn.click();
    } else {
        console.log('Send to cutter button not found!');
    }
    
    // Wait for conversion and tab switch
    await page.waitForTimeout(1000);
    
    // Click Measure
    const measureBtn = await page.$('#btnMeasurePreview');
    if (measureBtn) {
        await measureBtn.click();
        await page.waitForTimeout(100);
    } else {
        console.log('Measure button not found!');
    }
    
    // Click and drag on trajectory canvas
    const trajCanvas = await page.$('#gcodeCanvas');
    const tbox = await trajCanvas.boundingBox();
    
    console.log('Starting drag on gcodeCanvas...');
    await page.mouse.move(tbox.x + 150, tbox.y + 150);
    await page.mouse.down();
    await page.mouse.move(tbox.x + 250, tbox.y + 250, { steps: 10 });
    await page.mouse.up();
    
    await page.waitForTimeout(500);
    
    await browser.close();
})();
