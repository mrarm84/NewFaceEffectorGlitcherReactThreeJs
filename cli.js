#!/usr/bin/env node

import { program } from 'commander';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

program
  .name('face-glitch-cli')
  .description('CLI tool for exporting face glitch effects')
  .version('1.0.0')
  .option('-p, --preset <name|path>', 'Preset name (from app) or path to preset JSON file')
  .option('-i, --input <path>', 'Input image path')
  .option('-f, --format <format>', 'Export format (A1, A2, A3, A4, ORYG)', 'A4')
  .option('-o, --output <path>', 'Output path (defaults to ./output.jpg)', 'output.jpg')
  .option('-u, --url <url>', 'App URL (defaults to http://localhost:8080)', 'http://localhost:8080')
  .action(async (options) => {
    const { preset, input, format, output, url } = options;

    if (!input) {
      console.error('Error: Input path is required');
      process.exit(1);
    }

    const inputPath = path.resolve(input);
    if (!fs.existsSync(inputPath)) {
      console.error(`Error: Input file not found: ${inputPath}`);
      process.exit(1);
    }

    const outputPath = path.resolve(output);
    const downloadDir = path.dirname(outputPath);

    console.log(`🚀 Starting export...`);
    console.log(`   Input:  ${inputPath}`);
    console.log(`   Preset: ${preset || 'Default'}`);
    console.log(`   Format: ${format}`);

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });

    try {
      const page = await browser.newPage();
      
      // Setup download behavior
      const client = await page.target().createCDPSession();
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
      });

      await page.goto(url, { waitUntil: 'networkidle2' });

      // 1. Load the preset
      if (preset) {
        let presetData = null;
        try {
          if (fs.existsSync(preset)) {
            console.log(`   Loading preset from file: ${preset}...`);
            presetData = JSON.parse(fs.readFileSync(preset, 'utf8'));
          }
        } catch (e) {
          console.log(`   Preset argument is not a file, treating as name.`);
        }

        await page.evaluate((pName, pData) => {
          if (pData) {
            window._cli_loadPreset(pData);
          } else {
            console.log(`   Searching for preset: ${pName}...`);
            const presets = window._cli_getPresets();
            const p = presets.find(x => x.name === pName);
            if (p) {
              window._cli_loadPreset(p);
            } else {
              console.warn(`Preset "${pName}" not found in browser storage.`);
            }
          }
        }, preset, presetData);
      }

      // 2. Load the input image
      console.log(`   Loading image...`);
      // We need to pass the file content or a local URL. 
      // Puppeteer can't easily fetch local files from the page unless we serve them or use data URL.
      const imageBase64 = fs.readFileSync(inputPath, { encoding: 'base64' });
      const mimeType = inputPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const dataUrl = `data:${mimeType};base64,${imageBase64}`;

      await page.evaluate((dUrl) => {
        window._cli_loadMedia(dUrl);
      }, dataUrl);

      // 3. Wait for MediaPipe to be ready and landmarks to be populated
      console.log(`   Waiting for MediaPipe and detection...`);
      await page.waitForFunction(() => {
        // Check if models are ready and landmarks are detected (or at least attempted)
        // We look for the loading overlay to disappear as a sign of readiness
        const overlay = document.querySelector('.loading-overlay');
        return !overlay;
      }, { timeout: 30000 });

      // Give it a bit more time for stable detection
      await new Promise(r => setTimeout(r, 2000));

      // 4. Trigger export
      console.log(`   Triggering export (${format})...`);
      
      // Filename expectation: face-effector-a4-123456789.jpg
      // We'll watch the download directory for new files
      const beforeFiles = new Set(fs.readdirSync(downloadDir));

      await page.evaluate((fmt) => {
        if (fmt === 'ORYG') {
          window.exportOryg();
        } else {
          window.exportImage(fmt);
        }
      }, format);

      // Wait for the new file to appear
      let downloadedFile = null;
      let attempts = 0;
      while (attempts < 60) {
        const afterFiles = fs.readdirSync(downloadDir);
        const newFiles = afterFiles.filter(f => !beforeFiles.has(f));
        if (newFiles.length > 0) {
          downloadedFile = newFiles[0];
          // Wait for file to be fully written (if it's a partial download)
          if (!downloadedFile.endsWith('.crdownload')) {
            break;
          }
        }
        await new Promise(r => setTimeout(r, 500));
        attempts++;
      }

      if (downloadedFile) {
        const tempPath = path.join(downloadDir, downloadedFile);
        fs.renameSync(tempPath, outputPath);
        console.log(`✅ Export successful: ${outputPath}`);
      } else {
        throw new Error('Download timed out');
      }

    } catch (err) {
      console.error(`❌ Export failed: ${err.message}`);
      process.exit(1);
    } finally {
      await browser.close();
    }
  });

program.parse();
