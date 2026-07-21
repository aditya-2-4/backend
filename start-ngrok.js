import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function start() {
  console.log('Starting Ngrok tunnel on port 5000...');
  
  // Use the native ngrok CLI tool via npx or global path
  const ngrokProcess = spawn('ngrok.cmd', ['http', '5000', '--log=stdout', '--log-format=json'], {
    shell: true
  });

  let urlFound = false;

  ngrokProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const logObj = JSON.parse(line);
        if (logObj.msg === 'started tunnel' && logObj.url) {
          if (!urlFound) {
            urlFound = true;
            handleNgrokUrl(logObj.url);
          }
        }
      } catch (e) {
        // Not a JSON line or incomplete chunk
      }
    }
  });

  ngrokProcess.stderr.on('data', (data) => {
    console.error('Ngrok error:', data.toString());
  });

  ngrokProcess.on('close', (code) => {
    console.log(`Ngrok process exited with code ${code}`);
  });
}

function handleNgrokUrl(url) {
  console.log(`\n========================================`);
  console.log(`✅ NGROK TUNNEL STARTED: ${url}`);
  console.log(`========================================\n`);

  const wsUrl = url.replace('https://', 'wss://').replace('http://', 'ws://');
  
  // Update frontend config.js
  const configPath = path.join(__dirname, '..', 'farmguard', 'src', 'config.js');
  let configContent = fs.readFileSync(configPath, 'utf8');
  
  // Replace API_URL and WS_URL fallback values
  configContent = configContent.replace(
    /export const API_URL = (.*?)\? envApiUrl : '.*?';/,
    `export const API_URL = $1? envApiUrl : '${url}';`
  );
  configContent = configContent.replace(
    /export const WS_URL = (.*?)\? envWsUrl : '.*?';/,
    `export const WS_URL = $1? envWsUrl : '${wsUrl}';`
  );
  
  fs.writeFileSync(configPath, configContent);
  console.log('Updated frontend config.js with new Ngrok URL.');

  // Commit and push the frontend changes to trigger Vercel deploy
  try {
    console.log('Pushing changes to Git to trigger Vercel deployment...');
    const frontendDir = path.join(__dirname, '..', 'farmguard');
    
    const gitStatus = execSync('git status --porcelain src/config.js', { cwd: frontendDir }).toString();
    if (gitStatus.trim() !== '') {
      execSync('git add src/config.js', { cwd: frontendDir });
      execSync('git commit -m "Update ngrok URL for Vercel deployment"', { cwd: frontendDir });
      execSync('git push', { cwd: frontendDir });
      console.log('✅ Successfully pushed to Git! Vercel is building the new URL...');
    } else {
      console.log('No changes to config.js detected.');
    }
  } catch (gitErr) {
    console.error('Failed to push to git (maybe already up to date, or git not initialized):', gitErr.message);
  }

  console.log('\nStarting backend server...');
  // Start backend server natively
  import('./server.js');
}

start();
